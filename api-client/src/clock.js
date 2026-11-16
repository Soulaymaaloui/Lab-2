// This module defines the clock abstraction used by the client and token bucket.
// Real clocks are kept in one place so tests can inject FakeClock and model time precisely.
export const realClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
};

/**
 * Deterministic clock for tests. Time only moves when you call advance().
 * Timers fire in (time, insertion) order; between timers we let all pending microtasks run,
 * so the code under test reacts exactly as it would in real life, only in zero real milliseconds.
 */
export class FakeClock {
  #now = 0;
  #seq = 0;
  #timers = new Map(); // id -> { at, seq, fn }

  now() { return this.#now; }

  setTimeout(fn, ms) {
    const id = ++this.#seq;
    this.#timers.set(id, { at: this.#now + Math.max(0, ms), seq: id, fn });
    return id;
  }

  clearTimeout(id) { this.#timers.delete(id); }

  /** Number of timers still scheduled. A finished/cancelled client must leave 0 behind. */
  get pending() { return this.#timers.size; }

  /** Times at which timers are scheduled (sorted) - handy to assert exact backoff delays. */
  get schedule() { return [...this.#timers.values()].map((t) => t.at).sort((a, b) => a - b); }

  async flush() {
    // setImmediate runs after the whole microtask queue has drained.
    await new Promise((r) => setImmediate(r));
  }

  async advance(ms) {
    const target = this.#now + ms;
    await this.flush();
    for (;;) {
      let next = null;
      for (const t of this.#timers.values()) {
        if (t.at <= target && (!next || t.at < next.at || (t.at === next.at && t.seq < next.seq))) next = t;
      }
      if (!next) break;
      this.#timers.delete(next.seq);
      this.#now = Math.max(this.#now, next.at);
      next.fn();
      await this.flush();
    }
    this.#now = target;
    await this.flush();
  }
}
