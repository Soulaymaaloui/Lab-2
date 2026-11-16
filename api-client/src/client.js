// ApiClient wraps a fetch-like API behind retry, deadline, rate-limit, and cancellation rules.
// The implementation is intentionally test-friendly: all timing is driven by an injected clock so
// deterministic tests can verify backoff, queueing, and timeout behavior without real wall-clock waits.
import { realClock } from './clock.js';
import { TokenBucket } from './token-bucket.js';
import {
  CancelledError, DeadlineExceededError, RetryExhaustedError, HttpError, NotRetryableError,
} from './errors.js';

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'TRACE']);

/**
 * @typedef {object} ClientOptions
 * @property {number} ratePerSecond        token refill rate
 * @property {number} burst                bucket capacity
 * @property {number} [attemptTimeoutMs=1000]
 * @property {number} [totalDeadlineMs=5000] budget for ALL attempts + backoff of one call
 *                                         (starts once the first token is obtained; see countQueueTime)
 * @property {number} [maxRetries=3]       retries after the first attempt
 * @property {number} [baseDelayMs=100]
 * @property {number} [capDelayMs=2000]
 * @property {number[]} [retryStatuses=[429,503]]
 * @property {boolean} [countQueueTime=false] if true, waiting for the very first token also eats the deadline
 * @property {typeof fetch} [fetch]        injected for tests
 * @property {import('./clock.js').realClock} [clock]
 * @property {() => number} [random]
 */
export class ApiClient {
  #o; #limiter;

  constructor(opts) {
    this.#o = {
      attemptTimeoutMs: 1000, totalDeadlineMs: 5000, maxRetries: 3,
      baseDelayMs: 100, capDelayMs: 2000, retryStatuses: [429, 503], countQueueTime: false,
      fetch: globalThis.fetch, clock: realClock, random: Math.random,
      ...opts,
    };
    this.#limiter = new TokenBucket({
      ratePerSecond: this.#o.ratePerSecond, burst: this.#o.burst, clock: this.#o.clock,
    });
  }

  get(url, init = {}) { return this.request(url, { ...init, method: 'GET' }); }
  post(url, init = {}) { return this.request(url, { ...init, method: 'POST' }); }

  /**
   * Resolves with a 2xx Response. Rejects with a typed error (see errors.js) otherwise.
   * init: { method, headers, body, signal, idempotencyKey }
   */
  async request(url, init = {}) {
    const o = this.#o;
    const clock = o.clock;
    const { signal: callerSignal, idempotencyKey, ...fetchInit } = init;
    const method = (fetchInit.method ?? 'GET').toUpperCase();
    const canRetry = IDEMPOTENT_METHODS.has(method) || Boolean(idempotencyKey);
    const headers = new Headers(fetchInit.headers);
    if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey); // same key on every attempt

    // One controller owns the whole call. Caller cancel and total deadline both abort it,
    // and everything below (token wait, backoff sleep, in-flight fetch) listens to its signal.
    const ctl = new AbortController();
    let deadlineHit = false;
    let deadlineTimer = null;
    const onCallerAbort = () => ctl.abort(callerSignal.reason);
    if (callerSignal) {
      if (callerSignal.aborted) throw new CancelledError('cancelled before start', { cause: callerSignal.reason });
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
    const armDeadline = () => {
      deadlineTimer = clock.setTimeout(() => { deadlineHit = true; ctl.abort(new Error('deadline')); }, o.totalDeadlineMs);
    };
    if (o.countQueueTime) armDeadline();

    let attempts = 0;
    let lastFailure = 'unknown';
    const failureError = () => (deadlineHit
      ? new DeadlineExceededError(o.totalDeadlineMs, attempts)
      : new CancelledError('cancelled by caller', { cause: callerSignal?.reason }));

    try {
      for (let attempt = 0; ; attempt++) {
        // ---- 1. wait for a token (fair FIFO, cancellable)
        try {
          await this.#limiter.acquire(ctl.signal);
        } catch (e) {
          if (e instanceof CancelledError) throw failureError();
          throw e;
        }
        if (attempt === 0 && !o.countQueueTime) armDeadline();

        // ---- 2. one attempt with its own timeout
        attempts++;
        const attemptCtl = new AbortController();
        let timedOut = false;
        const onParentAbort = () => attemptCtl.abort(ctl.signal.reason);
        ctl.signal.addEventListener('abort', onParentAbort, { once: true });
        const attemptTimer = clock.setTimeout(() => { timedOut = true; attemptCtl.abort(new Error('attempt timeout')); }, o.attemptTimeoutMs);

        let retryAfterMs = null;
        try {
          const res = await o.fetch(url, { ...fetchInit, headers, signal: attemptCtl.signal });
          if (res.ok) return res; // headers arrived in time; body reading is the caller's business
          await res.body?.cancel().catch(() => {}); // free the socket before deciding anything
          if (!o.retryStatuses.includes(res.status)) throw new HttpError(res.status, res);
          lastFailure = `HTTP ${res.status}`;
          retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), clock);
        } catch (e) {
          if (e instanceof HttpError) throw e;
          if (ctl.signal.aborted) throw failureError(); // caller cancel or deadline, not retryable
          lastFailure = timedOut ? `attempt timeout (${o.attemptTimeoutMs} ms)` : `network error (${e?.cause?.code ?? e?.message})`;
        } finally {
          clock.clearTimeout(attemptTimer);
          ctl.signal.removeEventListener('abort', onParentAbort);
        }

        // ---- 3. decide: retry or give up
        if (!canRetry) throw new NotRetryableError(method, lastFailure);
        if (attempt >= o.maxRetries) throw new RetryExhaustedError(attempts, lastFailure);

        const backoff = o.random() * Math.min(o.capDelayMs, o.baseDelayMs * 2 ** attempt); // full jitter
        const delay = retryAfterMs ?? backoff; // server's Retry-After beats our own guess
        await sleep(clock, delay, ctl.signal, failureError);
      }
    } finally {
      clock.clearTimeout(deadlineTimer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  }
}

/** Cancellable sleep; leaves no timer or listener behind in any outcome. */
function sleep(clock, ms, signal, makeError) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(makeError());
    const onAbort = () => { clock.clearTimeout(t); reject(makeError()); };
    const t = clock.setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Retry-After is either delta-seconds or an HTTP date. Returns ms or null. */
export function parseRetryAfter(value, clock) {
  if (value == null || value === '') return null;
  if (/^\d+$/.test(value.trim())) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}
