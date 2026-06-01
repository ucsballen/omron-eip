'use strict';
/**
 * Cross-cutting utilities used by multiple layers.
 *   - Semaphore: bounded-concurrency primitive for limiting in-flight CIP requests.
 *   - computeBackoffMs: exponential backoff with full jitter for reconnect schedules.
 *   - deepEqual: structural equality across primitives, BigInt, Buffer, plain objects, arrays.
 *     (Extracted from monitoredVariable.js so verifiedWriteVariable can reuse it.)
 */

/**
 * FIFO semaphore. Limits the number of concurrent operations to `permits`.
 * Used to throttle in-flight CIP requests so we don't overwhelm the PLC and
 * trigger storms of RESOURCE_UNAVAILABLE (0x02) responses.
 *
 *   const sem = new Semaphore(4);
 *   await sem.acquire();
 *   try { await doWork(); } finally { sem.release(); }
 *
 * Or with the convenience wrapper:
 *   await sem.run(async () => doWork());
 *
 * Setting permits to 0 or a negative number disables the semaphore (acquire is instant).
 */
class Semaphore {
  /** @param {number} permits — maximum concurrent acquisitions; <=0 disables limiting */
  constructor(permits = Infinity) {
    this.permits = permits;
    this._inUse = 0;
    /** @type {Array<() => void>} */
    this._waiters = [];
  }

  /** Update the permit cap. If raising it, immediately release waiters. */
  setPermits(permits) {
    this.permits = permits;
    this._drain();
  }

  /** Acquire one permit. Resolves immediately if a permit is available; otherwise queues. */
  acquire() {
    if (this.permits <= 0 || this._inUse < this.permits) {
      this._inUse++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this._waiters.push(resolve));
  }

  /** Release one permit. If a waiter is queued, hand the permit to them. */
  release() {
    if (this._waiters.length > 0) {
      // Permit transfers directly to the next waiter; _inUse stays the same.
      const next = this._waiters.shift();
      next();
    } else if (this._inUse > 0) {
      this._inUse--;
    }
  }

  /** Convenience: acquire, run fn, release (even on throw). Returns fn's result. */
  async run(fn) {
    await this.acquire();
    try { return await fn(); }
    finally { this.release(); }
  }

  /** Approximate queue length — useful for logging / instrumentation. */
  get queuedCount() { return this._waiters.length; }
  get activeCount() { return this._inUse; }

  /** Used after raising permits, to wake up waiters that now have slots. */
  _drain() {
    while (this.permits > 0 && this._inUse < this.permits && this._waiters.length > 0) {
      const next = this._waiters.shift();
      this._inUse++;
      next();
    }
  }

  /**
   * Release all queued waiters AND reset _inUse to 0. Used during socket close —
   * waiters wake up, see the connection is dead, and reject naturally on their next
   * acquire/work. Subsequent calls to acquire() work normally.
   */
  releaseAll() {
    const waiters = this._waiters;
    this._waiters = [];
    this._inUse = 0;
    for (const w of waiters) w();
  }
}

/**
 * Compute the next reconnect delay using exponential backoff with full jitter.
 *
 * Formula (from "Exponential Backoff And Jitter", Marc Brooker, AWS Architecture Blog):
 *   delay = random_between(0, min(cap, base * 2^attempt))
 *
 * "Full jitter" gives the best behavior for many clients reconnecting to one server —
 * it avoids the thundering-herd reconnect storm where every client wakes up at the same
 * tick. attempt is 1-indexed (first retry uses attempt=1).
 *
 * @param {number} attempt    — 1-indexed retry attempt
 * @param {number} baseDelayMs — initial delay for attempt 1
 * @param {number} maxDelayMs  — ceiling
 * @returns {number} milliseconds to wait before next attempt
 */
function computeBackoffMs(attempt, baseDelayMs, maxDelayMs) {
  if (attempt < 1) attempt = 1;
  // 2^30 is plenty; capping the exponent prevents Number overflow at huge attempt counts.
  const exp = Math.min(attempt - 1, 30);
  const ceiling = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, exp));
  return Math.floor(Math.random() * ceiling);
}

/**
 * Structural deep equality. Handles:
 *   - primitives (===)
 *   - BigInt (===)
 *   - Buffer (.equals())
 *   - Array (recurse element-wise)
 *   - plain object (recurse key-wise)
 *
 * Used by MonitoredVariable change detection and verifiedWriteVariable read-back compare.
 * Does NOT handle Date, Map, Set, RegExp, class instances — none of which appear in
 * CIP type round-trips.
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return a.equals(b);
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
  return true;
}

module.exports = { Semaphore, computeBackoffMs, deepEqual };
