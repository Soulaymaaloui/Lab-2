// TokenBucket is the rate-limiter used by ApiClient. It enforces a FIFO queue so callers wait in
// a fair order and never bypass earlier waiters even when tokens happen to become available at the same time.
import { realClock } from './clock.js';
import { CancelledError } from './errors.js';

/**
 * Token bucket with a strict FIFO queue of waiters.
 *
 *  - Tokens are computed lazily from elapsed time (tokens += elapsed * rate), never with setInterval:
 *    an interval drifts and would keep the process alive forever.
 *  - Exactly one timer exists, and only while somebody is waiting. When the queue is empty
 *    (everyone served or cancelled) the timer is cleared -> nothing dangles.
 *  - A new caller never jumps the queue: if anybody is already waiting it joins the back,
 *    even when a token happens to be available at that very instant.
 */
export class TokenBucket {
  #rate; #burst; #clock;
  #tokens; #last;
  #queue = []; // waiters, oldest first
  #timer = null;

  constructor({ ratePerSecond, burst, clock = realClock }) {
    if (!(ratePerSecond > 0) || !(burst >= 1)) throw new RangeError('ratePerSecond > 0 and burst >= 1 required');
    this.#rate = ratePerSecond;
    this.#burst = burst;
    this.#clock = clock;
    this.#tokens = burst;
    this.#last = clock.now();
  }

  get waiting() { return this.#queue.length; }

  /** Resolves when a token has been taken for the caller. Rejects with CancelledError if `signal` aborts first. */
  acquire(signal) {
    if (signal?.aborted) return Promise.reject(new CancelledError('cancelled before acquiring a token', { cause: signal.reason }));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: null };
      if (signal) {
        waiter.onAbort = () => {
          const i = this.#queue.indexOf(waiter);
          if (i === -1) return; // already served
          this.#queue.splice(i, 1);
          reject(new CancelledError('cancelled while waiting for a token', { cause: signal.reason }));
          if (this.#queue.length === 0) this.#stopTimer();
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.#queue.push(waiter);
      this.#drain();
    });
  }

  #refill() {
    const now = this.#clock.now();
    this.#tokens = Math.min(this.#burst, this.#tokens + ((now - this.#last) * this.#rate) / 1000);
    this.#last = now;
  }

  #stopTimer() {
    if (this.#timer !== null) { this.#clock.clearTimeout(this.#timer); this.#timer = null; }
  }

  #drain() {
    this.#stopTimer();
    this.#refill();
    while (this.#queue.length && this.#tokens >= 1 - 1e-9) {
      this.#tokens -= 1;
      const w = this.#queue.shift();
      if (w.signal) w.signal.removeEventListener('abort', w.onAbort);
      w.resolve();
    }
    if (this.#queue.length) {
      const waitMs = Math.max(1, Math.ceil(((1 - this.#tokens) / this.#rate) * 1000));
      this.#timer = this.#clock.setTimeout(() => { this.#timer = null; this.#drain(); }, waitMs);
    }
  }
}
