'use strict';
/**
 * MonitoredVariable: poll a tag at a fixed interval and emit 'change' when the value differs.
 *
 * Equivalent to aphyt's MonitoredVariable, but uses Node's EventEmitter instead of an
 * observer-list-and-callback pattern. The class-level cache (keyed by dispatcher + name)
 * is preserved so two callers asking for the same monitored variable get the same
 * underlying instance — the more frequent poll interval wins.
 *
 * Two niceties added in 0.2:
 *
 *   1. WeakRef-based registry. If a caller drops their reference without calling
 *      cancel(), a FinalizationRegistry sees the garbage collection and clears
 *      the timer plus the registry entry. Prevents silent timer leakage in
 *      long-running services that create many transient monitors.
 *
 *   2. Async iteration. Use the monitor as an async iterable to stream change
 *      events without wiring up an EventEmitter:
 *
 *        const monitor = new MonitoredVariable(plc, 'Counter');
 *        for await (const value of monitor) {
 *          console.log(value);
 *          if (value > 100) break;
 *        }
 */

const { EventEmitter } = require('events');
const { deepEqual } = require('../util');

class MonitoredVariable extends EventEmitter {
  /**
   * Registry of currently-active monitors, keyed by `${dispatcher.id}:${name}`. The
   * values are WeakRefs — if a monitor goes out of scope without being cancel()'d,
   * the WeakRef's target becomes undefined and the FinalizationRegistry below
   * runs cleanup.
   *
   * @type {Map<string, WeakRef<MonitoredVariable>>}
   */
  static _registry = new Map();

  /**
   * Runs when a MonitoredVariable is garbage-collected without being cancel()'d.
   * Cleans up its timer (held in a separate map so the GC'd instance doesn't
   * need to be reachable for cleanup to find it) and removes the registry entry.
   *
   * @type {FinalizationRegistry<{key: string, timerHolder: {timer: NodeJS.Timeout|null}}>}
   */
  static _finalizer = new FinalizationRegistry((heldValue) => {
    const { key, timerHolder } = heldValue;
    if (timerHolder.timer) {
      clearTimeout(timerHolder.timer);
      timerHolder.timer = null;
    }
    // Only remove the entry if it still points to the GC'd instance. (If someone
    // already replaced it via cancel+new, leave the new entry alone.)
    const entry = MonitoredVariable._registry.get(key);
    if (entry && entry.deref() === undefined) {
      MonitoredVariable._registry.delete(key);
    }
  });

  /**
   * @param {Object} dispatcher  object with readVariable / verifiedWriteVariable methods
   *                             (NSeries instance, NSeriesController, etc.)
   * @param {string} variableName
   * @param {Object} [opts]
   * @param {number} [opts.refreshTimeMs=50]   poll interval
   * @param {boolean} [opts.autoStart=true]    start the timer immediately
   */
  constructor(dispatcher, variableName, opts = {}) {
    const key = `${dispatcher.id || ''}:${variableName}`;
    const existingRef = MonitoredVariable._registry.get(key);
    const existing = existingRef && existingRef.deref();
    if (existing) {
      // Reuse the existing instance; lower the polling interval if asked for a faster one.
      const newInterval = opts.refreshTimeMs ?? existing.refreshTimeMs;
      if (newInterval < existing.refreshTimeMs) existing.refreshTimeMs = newInterval;
      return existing;
    }

    super();
    this._key = key;
    this.dispatcher = dispatcher;
    this.variableName = variableName;
    this.refreshTimeMs = opts.refreshTimeMs ?? 50;
    this._value = undefined;
    // Timer reference lives in a wrapper object so the FinalizationRegistry callback
    // can still see it after `this` becomes unreachable.
    this._timerHolder = { timer: null };
    this._stopped = false;

    MonitoredVariable._registry.set(key, new WeakRef(this));
    MonitoredVariable._finalizer.register(this, { key, timerHolder: this._timerHolder }, this);

    if (opts.autoStart !== false) this.start();
  }

  get value() { return this._value; }

  /** Write a new value through and update the local cache. */
  async setValue(v) {
    await this.dispatcher.verifiedWriteVariable(this.variableName, v);
    const prev = this._value;
    this._value = v;
    if (!deepEqual(prev, v)) this.emit('change', v, prev);
  }

  start() {
    if (this._stopped) return;
    if (this._timerHolder.timer) return;
    this._scheduleNext(0);
  }

  cancel() {
    this._stopped = true;
    if (this._timerHolder.timer) {
      clearTimeout(this._timerHolder.timer);
      this._timerHolder.timer = null;
    }
    MonitoredVariable._registry.delete(this._key);
    // Unregister from the finalizer so the GC callback doesn't fire later.
    MonitoredVariable._finalizer.unregister(this);
  }

  _scheduleNext(delay = this.refreshTimeMs) {
    if (this._stopped) return;
    this._timerHolder.timer = setTimeout(() => this._tick(), delay);
    if (this._timerHolder.timer.unref) this._timerHolder.timer.unref();
  }

  async _tick() {
    if (this._stopped) return;
    try {
      const v = await this.dispatcher.readVariable(this.variableName);
      const prev = this._value;
      this._value = v;
      if (!deepEqual(prev, v)) this.emit('change', v, prev);
    } catch (err) {
      this.emit('error', err);
    } finally {
      this._scheduleNext();
    }
  }

  // ------------------------------------------------------------- async iteration

  /**
   * Use the monitor as an async iterable. Each iteration yields the next CHANGED
   * value (not every poll — only ones that differ from the previous value). The
   * iterator ends when the monitor is canceled.
   *
   *   for await (const value of monitor) { ... }
   *
   * Errors from the underlying read throw out of the for-await loop.
   */
  [Symbol.asyncIterator]() { return this.asyncIterator(); }

  asyncIterator() {
    const queue = [];          // pending values waiting to be consumed
    const errors = [];         // pending errors to throw
    let resolveNext = null;    // resolver for an awaiting consumer
    let rejectNext = null;
    let done = false;

    const onChange = (newValue) => {
      if (done) return;
      if (resolveNext) {
        const fn = resolveNext; resolveNext = null; rejectNext = null;
        fn({ value: newValue, done: false });
      } else {
        queue.push(newValue);
      }
    };
    const onError = (err) => {
      if (done) return;
      if (rejectNext) {
        const fn = rejectNext; resolveNext = null; rejectNext = null;
        fn(err);
      } else {
        errors.push(err);
      }
    };

    this.on('change', onChange);
    this.on('error', onError);

    const cleanup = () => {
      done = true;
      this.off('change', onChange);
      this.off('error', onError);
    };

    return {
      next: () => {
        if (errors.length > 0) return Promise.reject(errors.shift());
        if (queue.length > 0)  return Promise.resolve({ value: queue.shift(), done: false });
        if (done || this._stopped) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => {
          resolveNext = resolve;
          rejectNext = reject;
        });
      },
      return: () => { cleanup(); return Promise.resolve({ value: undefined, done: true }); },
      throw: (err) => { cleanup(); return Promise.reject(err); },
      [Symbol.asyncIterator]() { return this; },
    };
  }
}

module.exports = { MonitoredVariable };
