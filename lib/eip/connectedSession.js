'use strict';
/**
 * Class 3 connected explicit messaging for Omron NX/NJ controllers.
 *
 * Opt-in via `useConnectedMessaging: true` on the NSeries constructor. When enabled, the
 * session opens a CIP Class 3 connection to the controller's Message Router and routes
 * every subsequent CIP request through it. If the controller rejects the connection for
 * any reason, the NSeries layer transparently falls back to unconnected (UCMM) messaging,
 * so turning this on never breaks anything.
 *
 * AUTOMATIC NEGOTIATION
 * ---------------------
 * Omron firmware does not accept the Large_Forward_Open (service 0x5B) that many other
 * CIP devices use - it rejects it with CIP status 0x01 / extended status 0x0801. It does
 * accept the classic Forward_Open (service 0x54). Rather than make the caller know this,
 * `open()` tries a short list of parameter variants in order and uses the first one the
 * controller accepts. On NX/NJ the very first variant (Small Forward_Open) succeeds, so
 * negotiation costs nothing in the common case. The variant list can be overridden by
 * passing `forwardOpenVariants` in the options, and any single field can be pinned by
 * passing it directly (e.g. `useLargeForwardOpen: true`).
 *
 * REPLY CORRELATION
 * -----------------
 * Connected messages use the EIP SendUnitData command (0x70), not SendRRData (0x6F).
 * Omron zeros the sender_context on connected replies, so replies are correlated by the
 * T->O connection ID carried in the reply's connected-address item (0xA1) rather than by
 * context. The dispatcher handles this automatically when given the connection ID.
 *
 * FORWARD_OPEN REQUEST BODY (service 0x54 / 0x5B, to Connection Manager class 06 inst 1)
 *   [priority + tick time]    1 byte
 *   [timeout ticks]           1 byte
 *   [O->T connection ID]      4 bytes   we send 0; the target assigns it in the reply
 *   [T->O connection ID]      4 bytes   we pick it; the target echoes it in the reply
 *   [connection serial]       2 bytes
 *   [vendor ID]               2 bytes
 *   [originator serial]       4 bytes
 *   [connection timeout mult] 1 byte
 *   [reserved]                3 bytes
 *   [O->T RPI microseconds]   4 bytes
 *   [O->T network params]     2 bytes (0x54) or 4 bytes (0x5B)
 *   [T->O RPI microseconds]   4 bytes
 *   [T->O network params]     2 bytes (0x54) or 4 bytes (0x5B)
 *   [transport class/trigger] 1 byte    0xA3 = server + application-triggered + class 3
 *   [connection path size]    1 byte    in 16-bit words
 *   [connection path]         4 bytes   20 02 24 01  (Message Router: class 02, instance 01)
 */

const { CIPRequest, CIPReply, CIPException, addressRequestPathSegment } = require('../cip');
const { DataAndAddressItem, CommonPacketFormat, CommandSpecificData } = require('./messages');
const { Semaphore } = require('../util');

const FORWARD_OPEN_SERVICE       = Buffer.from([0x54]);
const LARGE_FORWARD_OPEN_SERVICE = Buffer.from([0x5b]);
const FORWARD_CLOSE_SERVICE      = Buffer.from([0x4e]);

const CONNECTION_MANAGER_PATH = addressRequestPathSegment({
  classId: Buffer.from([0x06]),
  instanceId: Buffer.from([0x01]),
});

const MESSAGE_ROUTER_CONN_PATH = Buffer.from([0x20, 0x02, 0x24, 0x01]);

// Default Forward_Open parameters. A "variant" is a partial override of these.
const DEFAULT_PARAMS = {
  rpiMicroseconds: 2000000,    // 2 s - connection heartbeat interval
  connectionSize: 500,         // max bytes per connected packet
  timeoutMultiplier: 2,        // connection inactivity timeout = RPI * 2^(N+2)
  transportClass: 0xA3,        // server + application-triggered + class 3
  priority: 0x06,              // Forward_Open priority + tick-time byte
  timeoutTicks: 0x09,          // Forward_Open timeout = priority_tick * timeoutTicks
  useLargeForwardOpen: false,  // Omron accepts the classic 0x54, not the large 0x5B
};

// Tried in order; the first accepted variant is used. NX/NJ accept the first one, so
// negotiation normally costs a single round-trip. Each entry merges over DEFAULT_PARAMS.
const DEFAULT_VARIANTS = [
  { useLargeForwardOpen: false },                       // classic Forward_Open (NX/NJ)
  { useLargeForwardOpen: false, transportClass: 0x83 }, // classic + cyclic trigger
  { useLargeForwardOpen: true },                        // large Forward_Open (other devices)
  { useLargeForwardOpen: true, transportClass: 0x83 },  // large + cyclic trigger
];

class ConnectedSession {
  /**
   * @param {Object} dispatcher  the EIPDispatcher
   * @param {Object} [opts]
   * @param {number}  [opts.rpiMicroseconds=2000000]
   * @param {number}  [opts.connectionSize=500]
   * @param {number}  [opts.timeoutMultiplier=2]
   * @param {number}  [opts.transportClass=0xA3]
   * @param {number}  [opts.priority=0x06]
   * @param {number}  [opts.timeoutTicks=0x09]
   * @param {boolean} [opts.useLargeForwardOpen=false]  pin Small (false) or Large (true)
   * @param {Array}   [opts.forwardOpenVariants]        override the negotiation list
   */
  constructor(dispatcher, opts = {}) {
    this.dispatcher = dispatcher;

    // Any explicitly-passed parameter (other than the variant list) pins that field across
    // every negotiation variant, so callers can force a specific RPI, size, etc.
    const { forwardOpenVariants, ...pinned } = opts;
    this.pinnedParams = pinned;
    this.variants = forwardOpenVariants || DEFAULT_VARIANTS;

    this.isOpen = false;
    this.params = null;          // the accepted parameter set, populated by open()
    this.otConnectionId = 0;     // O->T - assigned by the PLC; used to address outgoing packets
    this.toConnectionId = 0;     // T->O - chosen by us; used to correlate incoming replies
    this.connectionSerial = 0;
    this.vendorId = 0x1337;      // arbitrary; only needs to round-trip to Forward_Close
    this.originatorSerial = Math.floor(Math.random() * 0xFFFFFFFF) >>> 0;
    this.sequenceCount = 0;
    this.lastOpenError = null;

    // A Class 3 connection is inherently sequential: the controller processes connected
    // requests in order, and replies are correlated by sequence count. Serialize sendCip
    // through a 1-permit semaphore so concurrent callers queue instead of clobbering each
    // other on the wire. (This is why connected throughput equals UCMM on a direct link —
    // a single connection can't have multiple requests truly in flight.)
    this._sendMutex = new Semaphore(1);
  }

  /**
   * Open the Class 3 connection, negotiating the Forward_Open variant automatically.
   * Returns true on success. Throws the final CIPException if every variant is rejected;
   * the same error is also stored on `this.lastOpenError` for diagnostics.
   */
  async open() {
    if (this.isOpen) return true;
    this.lastOpenError = null;

    for (const variant of this.variants) {
      const params = { ...DEFAULT_PARAMS, ...variant, ...this.pinnedParams };
      try {
        await this._attemptForwardOpen(params);
        this.params = params;
        this.isOpen = true;
        this.dispatcher.logger.info('Class 3 connection opened', {
          otId: '0x' + this.otConnectionId.toString(16),
          toId: '0x' + this.toConnectionId.toString(16),
          forwardOpen: params.useLargeForwardOpen ? 'large(0x5B)' : 'small(0x54)',
        });
        return true;
      } catch (err) {
        this.lastOpenError = err;
        // Try the next variant. A rejection here is expected during negotiation.
      }
    }

    // Every variant was rejected. Surface the last rejection.
    throw this.lastOpenError || new Error('Forward_Open rejected by all variants');
  }

  /** Issue one Forward_Open with the given parameters. Throws on rejection. */
  async _attemptForwardOpen(params) {
    // The originator picks T->O (the ID it uses to identify incoming packets from the
    // target). O->T is assigned by the target in its reply.
    this.toConnectionId = Math.floor(Math.random() * 0xFFFFFFFF) >>> 0;
    this.otConnectionId = 0;
    this.connectionSerial = Math.floor(Math.random() * 0xFFFF) & 0xFFFF;

    const body = this._buildForwardOpenBody(params);
    const service = params.useLargeForwardOpen ? LARGE_FORWARD_OPEN_SERVICE : FORWARD_OPEN_SERVICE;
    const request = new CIPRequest(service, CONNECTION_MANAGER_PATH, body);

    // Forward_Open itself always goes via UCMM.
    const reply = await this.dispatcher.executeCipCommand(request);

    // Success reply: [O->T connID 4][T->O connID 4][conn serial 2][vendor 2][orig serial 4]...
    this.otConnectionId = reply.replyData.readUInt32LE(0);
    const echoedToId = reply.replyData.readUInt32LE(4);

    if (this.otConnectionId === 0) {
      throw new Error(
        'Forward_Open reply has a zero O->T connection ID - reply layout not understood. ' +
        'Raw reply: ' + reply.replyData.toString('hex')
      );
    }
    if (echoedToId !== this.toConnectionId) {
      // Not fatal - some firmware reassigns it - but worth noting at debug level.
      this.dispatcher.logger.debug('Forward_Open T->O id not echoed exactly', {
        sent: '0x' + this.toConnectionId.toString(16),
        got: '0x' + echoedToId.toString(16),
      });
      this.toConnectionId = echoedToId;
    }
    this.sequenceCount = 0;
  }

  /** Send a CIPRequest over the connected path. Returns the unwrapped CIPReply.
   *  Serialized: a single Class 3 connection processes one request at a time. */
  async sendCip(cipRequest) {
    if (!this.isOpen) throw new Error('Class 3 connection not open');
    return this._sendMutex.run(() => this._sendCipLocked(cipRequest));
  }

  /** The actual send, run under the per-connection mutex. */
  async _sendCipLocked(cipRequest) {
    if (!this.isOpen) throw new Error('Class 3 connection not open');

    // Connected packets prepend a 16-bit sequence counter to the CIP message.
    this.sequenceCount = (this.sequenceCount + 1) & 0xFFFF;
    const seq = Buffer.alloc(2);
    seq.writeUInt16LE(this.sequenceCount, 0);
    const payload = Buffer.concat([seq, cipRequest.bytes]);

    // Outgoing packets carry the O->T connection ID (the PLC's routing ID) in the 0xA1
    // connected-address item. The PLC's reply carries the T->O ID, which the dispatcher
    // uses to correlate the reply back to this request.
    const connId = Buffer.alloc(4);
    connId.writeUInt32LE(this.otConnectionId, 0);
    const addressItem = new DataAndAddressItem(Buffer.from([0xa1, 0x00]), connId);
    const dataItem = new DataAndAddressItem(DataAndAddressItem.CONNECTED_TRANSPORT_PACKET, payload);
    const cpf = new CommonPacketFormat([addressItem, dataItem]);
    const csd = new CommandSpecificData({ encapsulatedPacket: cpf.bytes() });

    const replyCpf = await this.dispatcher.sendUnitData(csd.bytes(), this.toConnectionId);

    if (!replyCpf.packets || replyCpf.packets.length < 2) {
      throw new Error('Class 3 reply missing expected CPF items');
    }
    const responseItem = DataAndAddressItem.fromBytes(replyCpf.packets[1].bytes());
    if (!responseItem.data || responseItem.data.length < 2) {
      throw new Error('Class 3 reply data item too small');
    }
    // Strip the 2-byte sequence counter, then decode as a normal CIP reply.
    const cipReply = new CIPReply(responseItem.data.subarray(2));
    if (cipReply.generalStatus[0] !== 0) {
      throw new CIPException(cipReply.generalStatus, cipReply.extendedStatus);
    }
    return cipReply;
  }

  /** Close the connection with Forward_Close. Safe to call repeatedly. */
  async close() {
    if (!this.isOpen) return;
    try {
      const request = new CIPRequest(FORWARD_CLOSE_SERVICE, CONNECTION_MANAGER_PATH, this._buildForwardCloseBody());
      await this.dispatcher.executeCipCommand(request);
    } catch (err) {
      // Non-fatal: the PLC times the connection out on its own after the inactivity period.
      this.dispatcher.logger.debug('Forward_Close failed (non-fatal)', { error: err.message });
    } finally {
      this.isOpen = false;
    }
  }

  // ------------------------- private: body construction -------------------------

  _buildForwardOpenBody(params) {
    const large = params.useLargeForwardOpen;
    const netParam = large
      ? (params.connectionSize & 0xFFFF) | (0b10 << 16) | (0b01 << 18) | (1 << 26)
      : (params.connectionSize & 0x01FF) | (0b10 << 13) | (0b01 << 10) | (1 << 9);

    const buf = Buffer.alloc(48 + MESSAGE_ROUTER_CONN_PATH.length);
    let off = 0;
    buf.writeUInt8(params.priority & 0xFF, off); off += 1;
    buf.writeUInt8(params.timeoutTicks & 0xFF, off); off += 1;
    buf.writeUInt32LE(0, off); off += 4;                          // O->T - target assigns
    buf.writeUInt32LE(this.toConnectionId, off); off += 4;        // T->O - we pick
    buf.writeUInt16LE(this.connectionSerial, off); off += 2;
    buf.writeUInt16LE(this.vendorId, off); off += 2;
    buf.writeUInt32LE(this.originatorSerial, off); off += 4;
    buf.writeUInt8(params.timeoutMultiplier & 0x07, off); off += 1;
    off += 3;                                                      // reserved
    buf.writeUInt32LE(params.rpiMicroseconds, off); off += 4;
    if (large) { buf.writeUInt32LE(netParam >>> 0, off); off += 4; }
    else       { buf.writeUInt16LE(netParam & 0xFFFF, off); off += 2; }
    buf.writeUInt32LE(params.rpiMicroseconds, off); off += 4;
    if (large) { buf.writeUInt32LE(netParam >>> 0, off); off += 4; }
    else       { buf.writeUInt16LE(netParam & 0xFFFF, off); off += 2; }
    buf.writeUInt8(params.transportClass & 0xFF, off); off += 1;
    buf.writeUInt8(MESSAGE_ROUTER_CONN_PATH.length / 2, off); off += 1;
    MESSAGE_ROUTER_CONN_PATH.copy(buf, off); off += MESSAGE_ROUTER_CONN_PATH.length;
    return buf.subarray(0, off);
  }

  _buildForwardCloseBody() {
    const buf = Buffer.alloc(12 + MESSAGE_ROUTER_CONN_PATH.length);
    let off = 0;
    buf.writeUInt8(0x06, off); off += 1;                          // priority + tick time
    buf.writeUInt8(0x09, off); off += 1;                          // timeout ticks
    buf.writeUInt16LE(this.connectionSerial, off); off += 2;
    buf.writeUInt16LE(this.vendorId, off); off += 2;
    buf.writeUInt32LE(this.originatorSerial, off); off += 4;
    buf.writeUInt8(MESSAGE_ROUTER_CONN_PATH.length / 2, off); off += 1;
    off += 1;                                                      // reserved
    MESSAGE_ROUTER_CONN_PATH.copy(buf, off); off += MESSAGE_ROUTER_CONN_PATH.length;
    return buf.subarray(0, off);
  }
}

module.exports = { ConnectedSession };
