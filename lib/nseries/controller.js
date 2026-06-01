'use strict';
/**
 * NSeriesController: a resilient, EventEmitter-based wrapper around NSeries.
 *
 * Equivalent to aphyt's NSeriesThreadDispatcher, minus the Python thread pool (Node is already
 * async). Adds:
 *   • Auto-reconnect on socket errors with configurable retry/backoff.
 *   • Optional keep-alive heartbeat (list_services on an interval).
 *   • 'connect' / 'disconnect' / 'reconnect' / 'error' events.
 *   • Convenience: every read/write attempt is queued onto a single pending chain so the
 *     reconnect logic doesn't race against in-flight requests.
 *
 * This is what most production callers should use. Bare NSeries is fine for one-shots and tests.
 */

const { EventEmitter } = require('events');
const { NSeries } = require('./nseries');
const { computeBackoffMs } = require('../util');

let _idCounter = 0;

class NSeriesController extends EventEmitter {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.host]
   * @param {number} [opts.connectionTimeoutMs=5000]
   * @param {number} [opts.requestTimeoutMs=10000]
   * @param {number} [opts.reconnectDelayMs=1000]              base for backoff (attempt 1's max)
   * @param {number} [opts.reconnectMaxDelayMs=30000]          ceiling for backoff
   * @param {boolean} [opts.reconnectBackoffJitter=true]       use exponential backoff w/ full jitter
   * @param {number} [opts.maxReconnectAttempts=Infinity]      set to 0 to disable auto-reconnect
   * @param {boolean} [opts.keepAlive=false]
   * @param {number} [opts.keepAliveIntervalMs=5000]
   * @param {boolean} [opts.autoConnect=false]                 connect immediately on construction
   * @param {number} [opts.maxConcurrentRequests=8]            passed to the dispatcher
   * @param {boolean} [opts.useConnectedMessaging=false]       attempt Class 3 connected explicit messaging
   * @param {Object} [opts.logger]                             { debug, info, warn, error }
   */
  constructor(opts = {}) {
    super();
    this.id = `nsctrl_${++_idCounter}`; // used by MonitoredVariable for cache keys
    this.opts = {
      host: null,
      connectionTimeoutMs: 5000,
      requestTimeoutMs: 10000,
      reconnectDelayMs: 1000,
      reconnectMaxDelayMs: 30000,
      reconnectBackoffJitter: true,
      maxReconnectAttempts: Infinity,
      keepAlive: false,
      keepAliveIntervalMs: 5000,
      autoConnect: false,
      maxConcurrentRequests: 8,
      useConnectedMessaging: false,
      logger: null,
      ...opts,
    };
    this.host = this.opts.host;

    /** @type {NSeries|null} */ this.plc = null;
    this.connected = false;
    this.connecting = false;
    this.reconnecting = false;
    this._keepAliveTimer = null;
    this._reconnectAttempts = 0;
    this._closed = false;

    // Serialize all PLC ops on a single tail Promise. Prevents reconnect from racing
    // against an in-flight read.
    this._opChain = Promise.resolve();

    if (this.opts.autoConnect) {
      this.connect().catch(err => this.emit('error', err));
    }
  }

  // ------------------------------------------------------------- lifecycle

  async connect(host = this.host) {
    if (host) this.host = host;
    if (this.connected || this.connecting) return;
    this.connecting = true;
    this._closed = false;
    try {
      const plc = new NSeries({
        host: this.host,
        connectionTimeoutMs: this.opts.connectionTimeoutMs,
        requestTimeoutMs: this.opts.requestTimeoutMs,
        maxConcurrentRequests: this.opts.maxConcurrentRequests,
        useConnectedMessaging: this.opts.useConnectedMessaging,
        logger: this.opts.logger,
      });
      // Forward dispatcher-level events so callers can subscribe at the controller.
      plc.dispatcher.on('error', err => this.emit('dispatcherError', err));
      plc.dispatcher.on('close', () => this._onDispatcherClose());

      await plc.connect();
      this.plc = plc;
      this.connected = true;
      this.connecting = false;
      this._reconnectAttempts = 0;
      this.emit('connect');
      if (this.opts.keepAlive) this._startKeepAlive();
    } catch (err) {
      this.connecting = false;
      this.emit('error', err);
      this._scheduleReconnect();
      throw err;
    }
  }

  /** Close cleanly and stop all reconnect/keep-alive activity. */
  async close() {
    this._closed = true;
    this._stopKeepAlive();
    this.connected = false;
    if (this.plc) {
      try { await this.plc.close(); } catch (_) {}
      this.plc = null;
    }
    this.emit('disconnect');
  }

  _onDispatcherClose() {
    if (this._closed) return;
    this.connected = false;
    this._stopKeepAlive();
    this.emit('disconnect');
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._closed) return;
    if (this.reconnecting) return;
    if (this.opts.maxReconnectAttempts === 0) return;
    this.reconnecting = true;
    const attempt = ++this._reconnectAttempts;

    if (attempt > this.opts.maxReconnectAttempts) {
      this.reconnecting = false;
      this.emit('error', new Error(`Exceeded maxReconnectAttempts (${this.opts.maxReconnectAttempts})`));
      return;
    }

    // Exponential backoff with full jitter: when multiple clients are reconnecting
    // to the same PLC, this prevents the thundering-herd reconnect storm where every
    // client wakes up at the same tick and triggers RESOURCE_UNAVAILABLE on the PLC.
    const delay = this.opts.reconnectBackoffJitter
      ? computeBackoffMs(attempt, this.opts.reconnectDelayMs, this.opts.reconnectMaxDelayMs)
      : Math.min(this.opts.reconnectDelayMs, this.opts.reconnectMaxDelayMs);

    const t = setTimeout(async () => {
      this.reconnecting = false;
      if (this._closed) return;
      try {
        // Tear down any half-open state.
        if (this.plc) { try { await this.plc.close(); } catch (_) {} this.plc = null; }
        await this.connect();
        this.emit('reconnect', attempt);
      } catch (_) {
        // connect() already scheduled the next attempt via its catch branch.
      }
    }, delay);
    if (t.unref) t.unref();
  }

  _startKeepAlive() {
    this._stopKeepAlive();
    const tick = async () => {
      if (!this.connected || !this.plc) return;
      try {
        await this.plc.dispatcher.listServices();
      } catch (err) {
        this.emit('dispatcherError', err);
        // The dispatcher's close event will trigger reconnect.
      } finally {
        if (this.connected && !this._closed) {
          this._keepAliveTimer = setTimeout(tick, this.opts.keepAliveIntervalMs);
          if (this._keepAliveTimer.unref) this._keepAliveTimer.unref();
        }
      }
    };
    this._keepAliveTimer = setTimeout(tick, this.opts.keepAliveIntervalMs);
    if (this._keepAliveTimer.unref) this._keepAliveTimer.unref();
  }

  _stopKeepAlive() {
    if (this._keepAliveTimer) {
      clearTimeout(this._keepAliveTimer);
      this._keepAliveTimer = null;
    }
  }

  // ------------------------------------------------------------- proxied operations
  // All proxied ops are queued onto _opChain so they execute in order and don't race
  // with reconnect.

  _queue(fn) {
    const next = this._opChain.then(async () => {
      if (!this.connected || !this.plc) throw new Error('Not connected');
      return fn(this.plc);
    });
    // Keep chain alive even if this op rejects.
    this._opChain = next.catch(() => {});
    return next;
  }

  readVariable(name)                          { return this._queue(p => p.readVariable(name)); }
  writeVariable(name, data)                   { return this._queue(p => p.writeVariable(name, data)); }
  verifiedWriteVariable(name, data, retry=2)  { return this._queue(p => p.verifiedWriteVariable(name, data, retry)); }

  /** Bulk read multiple tags in one round-trip (MSP with auto-fallback). */
  readVariables(names, opts)                  { return this._queue(p => p.readVariables(names, opts)); }
  /** Bulk write multiple tags in one round-trip. */
  writeVariables(values, opts)                { return this._queue(p => p.writeVariables(values, opts)); }

  updateVariableDictionary() { return this._queue(p => p.updateVariableDictionary()); }
  variableList()             { return this.plc ? this.plc.variableList() : []; }
  userVariableList()         { return this.plc ? this.plc.userVariableList() : []; }
  systemVariableList()       { return this.plc ? this.plc.systemVariableList() : []; }

  saveCurrentDictionary(file)        { return this._queue(p => p.saveCurrentDictionary(file)); }
  loadDictionaryFile(file)           { return this._queue(p => p.loadDictionaryFile(file)); }
  loadDictionaryFileIfPresent(file)  { return this._queue(p => p.loadDictionaryFileIfPresent(file)); }
}

module.exports = { NSeriesController };
