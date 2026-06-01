'use strict';
/**
 * EIP TCP dispatcher: manages the TCP socket, registers the EIP session, frames CIP
 * requests inside EIP messages, correlates replies to requests via the 8-byte sender_context
 * (used here as a unique uint64 message number), and surfaces CIPReply / CIPException.
 *
 * Diverges from the Python aphyt port in one important way: instead of the recursive
 * `get_response` cache trick (which collides with Python's GIL-protected dict access),
 * each in-flight request is tracked by a Promise stored in `pendingRequests`, keyed
 * by the sender_context. The TCP reader matches incoming EIP messages to those Promises.
 * Replies with general_status == 0x02 (RESOURCE_UNAVAILABLE) automatically retry up to
 * `resourceUnavailableRetries` times, matching aphyt's intent without recursion stack.
 */

const net = require('net');
const { EventEmitter } = require('events');

const {
  CIPRequest, CIPReply, CIPException, CIPService,
  addressRequestPathSegment,
} = require('../cip');
const {
  DataAndAddressItem, CommonPacketFormat, CommandSpecificData, EIPMessage,
} = require('./messages');
const { Semaphore } = require('../util');

const EIP_PORT = 44818;
const HEADER_SIZE = 24;

/**
 * Extract the T->O connection ID from a connected (SendUnitData/0x70) reply. The PLC's
 * reply carries the T->O connection ID in its connected-address item, and that is the ID
 * the dispatcher uses to correlate the reply to the pending request.
 *
 * Layout after the 24-byte EIP header: [interface handle 4][timeout 2][item count 2]
 * then the first CPF item, which for a connected reply is the connected-address item
 * (type 0xA1, length 4, then the 4-byte connection ID). Returns null if the layout
 * doesn't look like a connected reply.
 */
function _extractConnectedReplyConnId(eipMessage) {
  try {
    const cd = eipMessage.commandData;            // bytes after the 24-byte header
    if (!cd || cd.length < 16) return null;
    // cd[0..3] interface handle, cd[4..5] timeout, cd[6..7] item count
    if (cd.readUInt16LE(6) < 2) return null;      // need at least the address + data items
    if (cd.readUInt16LE(8) !== 0xA1) return null; // first item must be a connected-address item
    if (cd.readUInt16LE(10) !== 4) return null;   // connection ID is 4 bytes
    return cd.readUInt32LE(12) >>> 0;
  } catch (_) {
    return null;
  }
}

class EIPDispatcher extends EventEmitter {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.host]
   * @param {number} [opts.connectionTimeoutMs=5000]
   * @param {number} [opts.requestTimeoutMs=10000]
   * @param {number} [opts.resourceUnavailableRetries=5]
   * @param {number} [opts.resourceUnavailableBackoffMs=10]
   * @param {number} [opts.maxConcurrentRequests=8]   in-flight cap; 0 or Infinity = unlimited
   * @param {Object} [opts.logger]                    optional { debug, info, warn, error } callbacks
   */
  constructor({
    host = null,
    connectionTimeoutMs = 5000,
    requestTimeoutMs = 10000,
    resourceUnavailableRetries = 5,
    resourceUnavailableBackoffMs = 10,
    maxConcurrentRequests = 8,
    logger = null,
  } = {}) {
    super();
    this.host = host;
    this.connectionTimeoutMs = connectionTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.resourceUnavailableRetries = resourceUnavailableRetries;
    this.resourceUnavailableBackoffMs = resourceUnavailableBackoffMs;
    this.logger = _normalizeLogger(logger);

    this.socket = null;
    this.sessionHandleId = Buffer.alloc(4); // empty until register_session succeeds
    this.isConnected = false;
    this.hasSession = false;

    // sender_context (BigInt) -> { resolve, reject, timer }
    this.pendingRequests = new Map();

    // Counter for sender_context. Starts near max so we'll fail fast on rollover errors, matching aphyt.
    this._messageNumber = 18446744073709551613n; // (2^64 - 3)

    // Buffer for partial reads — TCP gives us byte streams, we need framed messages.
    this._rxBuffer = Buffer.alloc(0);

    // Dispatcher-level variable dictionaries (populated by NSeries layer).
    this.variables = new Map();
    this.userVariables = new Map();
    this.systemVariables = new Map();
    this.dataTypeDictionary = new Map();

    // In-flight cap. Counter-intuitive default — 8 is empirically the sweet spot for
    // NX/NJ controllers under typical load. Bump to Infinity (or 0) if you want the old
    // unbounded behavior. Lower it (e.g. 4) if you hit RESOURCE_UNAVAILABLE storms.
    this._semaphore = new Semaphore(
      maxConcurrentRequests === 0 ? Infinity : maxConcurrentRequests
    );

    // Will be populated lazily when we attempt a Class 3 connection (see eip/connectedSession.js).
    this.connectedSession = null;

    // Default no-op 'error' listener. Node's EventEmitter throws if an 'error' is
    // emitted with zero listeners — which crashes the process. Socket errors
    // (ECONNRESET, etc.) should be observable by callers but not fatal by default.
    // Users who want to handle errors just add their own listener; this no-op
    // doesn't interfere with that.
    this.on('error', (err) => this.logger.warn('dispatcher error', { message: err && err.message }));
  }

  // ---------------------------------------------------------------- connection

  /** Open the TCP connection to host:44818. */
  async connectExplicit(host = this.host, timeoutMs = this.connectionTimeoutMs) {
    if (this.isConnected) return;
    this.host = host;
    if (!host) throw new Error('host is required');

    await new Promise((resolve, reject) => {
      const sock = new net.Socket();
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        if (err) {
          try { sock.destroy(); } catch (_) {}
          reject(err);
        } else {
          resolve();
        }
      };

      const timer = setTimeout(() => finish(new Error(`Connect to ${host}:${EIP_PORT} timed out`)), timeoutMs);

      sock.once('error', err => { clearTimeout(timer); finish(err); });
      sock.once('connect', () => {
        clearTimeout(timer);
        this.socket = sock;
        this.isConnected = true;
        this._wireSocketHandlers();
        finish();
      });

      sock.connect(EIP_PORT, host);
    });
  }

  _wireSocketHandlers() {
    this.socket.on('data', chunk => this._onData(chunk));
    this.socket.on('close', () => this._onClose());
    this.socket.on('error', err => this.emit('error', err));
  }

  /** Tear down the socket and reject anything still pending. */
  async closeExplicit() {
    this.isConnected = false;
    this.hasSession = false;
    if (this.socket) {
      try { this.socket.end(); } catch (_) {}
      try { this.socket.destroy(); } catch (_) {}
      this.socket = null;
    }
    this._rejectAllPending(new Error('Connection closed'));
  }

  _onClose() {
    this.isConnected = false;
    this.hasSession = false;
    this.socket = null;
    this._rejectAllPending(new Error('Connection closed by peer'));
    this.emit('close');
  }

  _rejectAllPending(err) {
    for (const { reject, timer } of this.pendingRequests.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pendingRequests.clear();
    // Also release any tasks waiting for a permit. They'll wake up, hit the
    // 'Not connected' check inside sendEipMessage, and reject naturally.
    this._semaphore.releaseAll();
  }

  // ---------------------------------------------------------------- RX

  /** Accumulate TCP bytes and emit complete EIPMessages as they arrive. */
  _onData(chunk) {
    this._rxBuffer = Buffer.concat([this._rxBuffer, chunk]);
    while (this._rxBuffer.length >= HEADER_SIZE) {
      const payloadLen = this._rxBuffer.readUInt16LE(2);
      const total = HEADER_SIZE + payloadLen;
      if (this._rxBuffer.length < total) break; // wait for more bytes
      const frame = this._rxBuffer.subarray(0, total);
      this._rxBuffer = this._rxBuffer.subarray(total);
      try {
        this._dispatchReply(EIPMessage.fromBytes(frame));
      } catch (err) {
        this.emit('error', err);
      }
    }
  }

  _dispatchReply(eipMessage) {
    const key = eipMessage.contextInteger();
    let pending = this.pendingRequests.get(key);

    // Connected messaging (SendUnitData / 0x70): Omron zeros the sender_context on
    // connected replies, so the context can't be the correlation key. Fall back to
    // matching by the T->O connection ID carried in the reply's connected-address item.
    if (!pending && eipMessage.command[0] === 0x70) {
      const connId = _extractConnectedReplyConnId(eipMessage);
      if (connId !== null) {
        const connKey = 'conn:' + connId.toString(16);
        pending = this.pendingRequests.get(connKey);
        if (pending) {
          this.pendingRequests.delete(connKey);
          clearTimeout(pending.timer);
          pending.resolve(eipMessage);
          return;
        }
      }
    }

    if (!pending) {
      // No one is waiting for this — likely a stale reply after a retry. Ignore it.
      return;
    }
    this.pendingRequests.delete(key);
    clearTimeout(pending.timer);
    pending.resolve(eipMessage);
  }

  // ---------------------------------------------------------------- TX

  _nextMessageNumber() {
    const n = this._messageNumber;
    // Wrap at 2^64 to keep BigInt unsigned (matches aphyt rollover guard).
    this._messageNumber = (this._messageNumber + 1n) & 0xFFFFFFFFFFFFFFFFn;
    return n;
  }

  /**
   * Send an EIPMessage and resolve when its matching reply arrives.
   *
   * Acquires one slot from the in-flight semaphore on entry and releases it when
   * the reply arrives or the request fails. This caps how many CIP requests can
   * be in flight simultaneously and prevents RESOURCE_UNAVAILABLE storms from
   * overly-eager Promise.all() callers.
   */
  sendEipMessage(eipMessage) {
    if (!this.isConnected || !this.socket) {
      return Promise.reject(new Error('Not connected'));
    }
    return this._semaphore.run(() => this._sendEipMessageRaw(eipMessage));
  }

  /**
   * Internal: send without going through the semaphore.
   * Used by sendEipMessage AND by callers that have already acquired a slot upstream
   * (e.g. batched multi-request operations that count as one slot).
   */
  _sendEipMessageRaw(eipMessage) {
    if (!this.isConnected || !this.socket) {
      return Promise.reject(new Error('Not connected'));
    }
    const ctx = this._nextMessageNumber();
    eipMessage.setContext(ctx);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.delete(ctx)) {
          this.logger.warn(`request timeout after ${this.requestTimeoutMs}ms`, { ctx: ctx.toString() });
          reject(new Error(`EIP request timed out after ${this.requestTimeoutMs}ms`));
        }
      }, this.requestTimeoutMs);

      this.pendingRequests.set(ctx, { resolve, reject, timer });
      try {
        this.socket.write(eipMessage.bytes());
      } catch (err) {
        this.pendingRequests.delete(ctx);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  // ---------------------------------------------------------------- EIP commands

  /** Register an EIP session — required before sending CIP messages. */
  async registerSession(commandData = Buffer.from([0x01, 0x00, 0x00, 0x00])) {
    const msg = new EIPMessage({ command: Buffer.from([0x65, 0x00]), commandData });
    const reply = await this.sendEipMessage(msg);
    this.sessionHandleId = reply.sessionHandleId;
    this.hasSession = true;
    return reply;
  }

  /** Wrap a CommandSpecificData payload as a SendRRData (0x6F) request/reply pair. */
  async sendRrData(commandSpecificDataBytes) {
    const msg = new EIPMessage({
      command: Buffer.from([0x6f, 0x00]),
      commandData: commandSpecificDataBytes,
      sessionHandleId: this.sessionHandleId,
    });
    const reply = await this.sendEipMessage(msg);
    const csd = CommandSpecificData.fromBytes(reply.commandData);
    return CommonPacketFormat.fromBytes(csd.encapsulatedPacket);
  }

  /** Same envelope as sendRrData but uses SendUnitData (0x70), the correct EIP command
   *  code for CONNECTED messages (Class 3 explicit). Omron NX/NJ firmware requires 0x70
   *  for connected traffic. Per CIP Vol.2 2-4.7 the timeout in the CSD must be 0 for
   *  SendUnitData - connected messages have their own timeout via the Forward_Open RPI.
   *
   *  @param {Buffer} commandSpecificDataBytes  the CSD (interface handle + timeout + CPF)
   *  @param {number} [connId]                  the T->O connection ID. The PLC carries this
   *                                            in its reply and zeros the sender_context, so
   *                                            the dispatcher correlates the reply by this ID
   *                                            instead of by context. Omit for stacks that
   *                                            echo the context (falls back to context match).
   */
  async sendUnitData(commandSpecificDataBytes, connId = null) {
    // Caller built the CSD with timeout=8 (the default for unconnected); patch the
    // timeout field to 0 in place. The CSD layout is: [interfaceHandle 4][timeout 2][...]
    const patched = Buffer.from(commandSpecificDataBytes);
    if (patched.length >= 6) {
      patched.writeUInt16LE(0, 4);
    }
    const msg = new EIPMessage({
      command: Buffer.from([0x70, 0x00]),
      commandData: patched,
      sessionHandleId: this.sessionHandleId,
    });

    // If we know the connection ID, register the pending request under a conn-key so
    // _dispatchReply can match the zeroed-context reply by connection ID. Otherwise fall
    // back to the normal context-keyed path (works on stacks that DO echo the context).
    let reply;
    if (connId !== null) {
      reply = await this._semaphore.run(() => this._sendConnectedRaw(msg, connId >>> 0));
    } else {
      reply = await this.sendEipMessage(msg);
    }
    const csd = CommandSpecificData.fromBytes(reply.commandData);
    return CommonPacketFormat.fromBytes(csd.encapsulatedPacket);
  }

  /** Send a connected (0x70) message, correlating the reply by connection ID. */
  _sendConnectedRaw(eipMessage, connId) {
    if (!this.isConnected || !this.socket) {
      return Promise.reject(new Error('Not connected'));
    }
    // Connected replies have their sender_context zeroed by the PLC, so we use a
    // connection-ID-derived key instead. The Class 3 session serializes requests, so
    // at most one connected request is outstanding per connection at a time.
    const connKey = 'conn:' + connId.toString(16);
    // Still assign a context (some stacks echo it; harmless if not).
    eipMessage.setContext(this._nextMessageNumber());

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.delete(connKey)) {
          this.logger.warn(`connected request timeout after ${this.requestTimeoutMs}ms`, { connKey });
          reject(new Error(`EIP request timed out after ${this.requestTimeoutMs}ms`));
        }
      }, this.requestTimeoutMs);

      this.pendingRequests.set(connKey, { resolve, reject, timer });
      try {
        this.socket.write(eipMessage.bytes());
      } catch (err) {
        this.pendingRequests.delete(connKey);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /** List EtherNet/IP services on the target. */
  async listServices() {
    const reply = await this.sendEipMessage(new EIPMessage({ command: Buffer.from([0x04, 0x00]) }));
    return reply.commandData;
  }

  /** List identity (vendor ID, device type, serial, etc.). */
  async listIdentity() {
    const reply = await this.sendEipMessage(new EIPMessage({ command: Buffer.from([0x63, 0x00]) }));
    return reply.commandData;
  }

  /** List non-CIP interfaces. */
  async listInterfaces() {
    const reply = await this.sendEipMessage(new EIPMessage({ command: Buffer.from([0x64, 0x00]) }));
    return reply.commandData;
  }

  // ---------------------------------------------------------------- CIP services

  /**
   * Wrap a CIP request inside an unconnected-message data item, send via send_rr_data,
   * unwrap and return the CIPReply. Raises CIPException on nonzero status. Retries
   * automatically on RESOURCE_UNAVAILABLE (0x02), since that just means the PLC is busy.
   *
   * If a connected session is open (Class 3 explicit messaging), the request is routed
   * through it instead of UCMM. The retry-on-0x02 behavior applies in either case.
   */
  async executeCipCommand(request) {
    let attempt = 0;
    /* eslint-disable no-constant-condition */
    while (true) {
      let cipReply;
      try {
        if (this.connectedSession && this.connectedSession.isOpen) {
          cipReply = await this.connectedSession.sendCip(request);
        } else {
          const dataItem = new DataAndAddressItem(DataAndAddressItem.UNCONNECTED_MESSAGE, request.bytes);
          const cpf = new CommonPacketFormat([dataItem]);
          const csd = new CommandSpecificData({ encapsulatedPacket: cpf.bytes() });
          const replyCpf = await this.sendRrData(csd.bytes());
          // packets[1] is the payload (packets[0] is the null-address item).
          const responseItem = DataAndAddressItem.fromBytes(replyCpf.packets[1].bytes());
          cipReply = new CIPReply(responseItem.data);
        }
      } catch (err) {
        // CIPException with status 0x02 might be thrown by connectedSession.sendCip directly;
        // re-check and retry.
        if (err instanceof CIPException && err.status[0] === 0x02
            && attempt < this.resourceUnavailableRetries) {
          attempt++;
          await new Promise(r => setTimeout(r, this.resourceUnavailableBackoffMs));
          continue;
        }
        throw err;
      }

      const statusByte = cipReply.generalStatus[0];
      if (statusByte === 0) return cipReply;

      if (statusByte === 0x02 && attempt < this.resourceUnavailableRetries) {
        attempt++;
        await new Promise(r => setTimeout(r, this.resourceUnavailableBackoffMs));
        continue;
      }
      throw new CIPException(cipReply.generalStatus, cipReply.extendedStatus);
    }
  }

  // ---- the standard CIP services, mirroring CIPDispatcher in aphyt ----

  readTagService(path, numberOfElements = 1) {
    const data = Buffer.alloc(2);
    data.writeUInt16LE(numberOfElements, 0);
    return this.executeCipCommand(new CIPRequest(CIPService.READ_TAG_SERVICE, path, data));
  }

  /**
   * @param {Buffer} path
   * @param {Object} requestServiceData — a CIPCommonFormat-like object:
   *        { dataType, additionalInfoLength?, additionalInfo?, data }
   * @param {number} [numberOfElements=1]
   */
  writeTagService(path, requestServiceData, numberOfElements = 1) {
    const n = Buffer.alloc(2);
    n.writeUInt16LE(numberOfElements, 0);
    const payload = Buffer.concat([
      requestServiceData.dataType,
      Buffer.from([requestServiceData.additionalInfoLength || 0]),
      requestServiceData.additionalInfo || Buffer.alloc(0),
      n,
      requestServiceData.data,
    ]);
    return this.executeCipCommand(new CIPRequest(CIPService.WRITE_TAG_SERVICE, path, payload));
  }

  getAttributeAllService(path) {
    return this.executeCipCommand(new CIPRequest(CIPService.GET_ATTRIBUTE_ALL, path));
  }

  getAttributeSingleService(path) {
    return this.executeCipCommand(new CIPRequest(CIPService.GET_ATTRIBUTE_SINGLE, path));
  }

  setAttributeSingleService(path, data) {
    return this.executeCipCommand(new CIPRequest(CIPService.SET_ATTRIBUTE_SINGLE, path, data));
  }

  /**
   * Omron-specific get_instance_list_ex2 (service 0x5F) on the Tag Name Server (class 0x6A).
   * Returns up to `numberOfInstances` instances, starting at `startInstanceId`.
   */
  getInstanceList(startInstanceId = 1, numberOfInstances = 1, userDefined = true) {
    const path = addressRequestPathSegment({
      classId: Buffer.from([0x6a]),
      instanceId: Buffer.from([0x00, 0x00]),
    });
    const kind = Buffer.alloc(2);
    kind.writeUInt16LE(userDefined ? 2 : 1, 0);
    const start = Buffer.alloc(4); start.writeUInt32LE(startInstanceId, 0);
    const count = Buffer.alloc(4); count.writeUInt32LE(numberOfInstances, 0);
    const data = Buffer.concat([start, count, kind]);
    return this.executeCipCommand(new CIPRequest(CIPService.GET_INSTANCE_LIST_EX2, path, data));
  }

  // ---------------------------------------------------------------- tuning

  /** Adjust the in-flight cap at runtime. Pass 0 or Infinity to disable. */
  setMaxConcurrentRequests(n) {
    this._semaphore.setPermits(n === 0 ? Infinity : n);
  }
}

/** Normalize a partial logger into a complete one. Accepts null, console, or {debug,info,warn,error}. */
function _normalizeLogger(logger) {
  const noop = () => {};
  if (!logger) return { debug: noop, info: noop, warn: noop, error: noop };
  return {
    debug: typeof logger.debug === 'function' ? logger.debug.bind(logger) : noop,
    info:  typeof logger.info  === 'function' ? logger.info.bind(logger)  : noop,
    warn:  typeof logger.warn  === 'function' ? logger.warn.bind(logger)  : noop,
    error: typeof logger.error === 'function' ? logger.error.bind(logger) : noop,
  };
}

module.exports = { EIPDispatcher, EIP_PORT };

