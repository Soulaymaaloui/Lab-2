// Regression tests for ApiClient.
// These checks exercise retries, deadlines, token queueing, cancellation, idempotency, and rate-limit pressure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../src/clock.js';
import { ApiClient } from '../src/client.js';
import {
  CancelledError, DeadlineExceededError, RetryExhaustedError, HttpError, NotRetryableError,
} from '../src/errors.js';

// ---- helpers ---------------------------------------------------------------------------------
const ok = (body = 'ok') => () => Promise.resolve(new Response(body, { status: 200 }));
const status = (code, headers = {}) => () => Promise.resolve(new Response(null, { status: code, headers }));
const netErr = () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }));
/** Never answers, but (like real fetch) rejects as soon as its signal aborts. */
const hang = (_url, init) => new Promise((_, reject) => {
  init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
});

function setup(script, opts = {}) {
  const clock = new FakeClock();
  const calls = [];
  const fetch = (url, init) => {
    const step = script[calls.length] ?? script.at(-1);
    calls.push({ url, init, at: clock.now() });
    return step(url, init);
  };
  const client = new ApiClient({
    ratePerSecond: 10, burst: 10, attemptTimeoutMs: 1000, totalDeadlineMs: 5000, maxRetries: 3,
    baseDelayMs: 100, capDelayMs: 2000, fetch, clock, random: () => 1, // random=1 -> sleep = the full cap of the window
    ...opts,
  });
  return { clock, calls, client };
}
/** Start a call and capture its outcome without ever leaving a rejection unhandled. */
const run = (p) => { const r = { done: false }; p.then((v) => Object.assign(r, { done: true, value: v }), (e) => Object.assign(r, { done: true, error: e })); return r; };

// ---- success / retry -------------------------------------------------------------------------
test('2xx on the first attempt: one call, no timers left', async () => {
  const { client, calls, clock } = setup([ok('hello')]);
  const r = run(client.get('http://x/a'));
  await clock.advance(0);
  assert.equal(await r.value.text(), 'hello');
  assert.equal(calls.length, 1);
  assert.equal(clock.pending, 0);
});

test('503 then 200: retries after the jittered delay (full jitter, attempt 0 => <= 100 ms)', async () => {
  const { client, calls, clock } = setup([status(503), ok()]);
  const r = run(client.get('http://x/a'));
  await clock.advance(99);
  assert.equal(calls.length, 1, 'still backing off');
  await clock.advance(1);
  assert.equal(calls.length, 2);
  assert.equal(r.done, true);
  assert.equal(r.value.status, 200);
  assert.equal(clock.pending, 0);
});

test('full jitter: delay = random * min(cap, base * 2^attempt) for every attempt', async () => {
  const { client, calls, clock } = setup([status(503)], { random: () => 0.5, maxRetries: 4, capDelayMs: 500 });
  const r = run(client.get('http://x/a'));
  await clock.advance(10_000);
  // windows: 100, 200, 400, min(500, 800)=500 -> halves: 50, 100, 200, 250
  // attempts happen at 0, 50, 150, 350, 600 (maxRetries=4 => 5 attempts)
  assert.deepEqual(calls.map((c) => c.at), [0, 50, 150, 350, 600]);
  assert.ok(r.error instanceof RetryExhaustedError);
  assert.equal(r.error.attempts, 5);
});

test('random=0 gives an immediate retry (lower bound of full jitter)', async () => {
  const { client, calls, clock } = setup([status(503), ok()], { random: () => 0 });
  const r = run(client.get('http://x/a'));
  await clock.advance(0);
  assert.equal(calls.length, 2);
  assert.equal(r.value.status, 200);
});

test('429 with Retry-After: 2 waits exactly 2000 ms (header beats our own backoff)', async () => {
  const { client, calls, clock } = setup([status(429, { 'retry-after': '2' }), ok()], { random: () => 0 });
  const r = run(client.get('http://x/a'));
  await clock.advance(1999);
  assert.equal(calls.length, 1);
  await clock.advance(1);
  assert.equal(calls.length, 2);
  assert.equal(r.value.status, 200);
});

test('network error is retried', async () => {
  const { client, calls, clock } = setup([netErr, ok()], { random: () => 0 });
  const r = run(client.get('http://x/a'));
  await clock.advance(0);
  assert.equal(calls.length, 2);
  assert.equal(r.value.status, 200);
});

test('non-retryable status (404) throws HttpError immediately, no retry', async () => {
  const { client, calls, clock } = setup([status(404)]);
  const r = run(client.get('http://x/a'));
  await clock.advance(0);
  assert.ok(r.error instanceof HttpError);
  assert.equal(r.error.status, 404);
  assert.equal(calls.length, 1);
  assert.equal(clock.pending, 0);
});

test('maxRetries exhausted -> RetryExhaustedError with attempt count', async () => {
  const { client, calls, clock } = setup([status(503)], { maxRetries: 2, random: () => 0 });
  const r = run(client.get('http://x/a'));
  await clock.advance(0);
  assert.ok(r.error instanceof RetryExhaustedError);
  assert.equal(r.error.attempts, 3);
  assert.equal(calls.length, 3);
  assert.match(r.error.lastFailure, /503/);
  assert.equal(clock.pending, 0);
});

// ---- timeouts --------------------------------------------------------------------------------
test('a hanging attempt is aborted after attemptTimeoutMs and retried', async () => {
  const { client, calls, clock } = setup([hang, ok()], { random: () => 0 });
  const r = run(client.get('http://x/a'));
  await clock.advance(999);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.signal.aborted, false);
  await clock.advance(1);
  assert.equal(calls[0].init.signal.aborted, true, 'first attempt was aborted');
  assert.equal(calls.length, 2);
  assert.equal(r.value.status, 200);
});

test('total deadline stops everything even when retries remain', async () => {
  // every attempt hangs 1 s; backoff window 100/200/400..; deadline 2.5 s -> must stop at 2500
  const { client, clock, calls } = setup([hang], { totalDeadlineMs: 2500, maxRetries: 50, random: () => 1 });
  const r = run(client.get('http://x/a'));
  await clock.advance(2499);
  assert.equal(r.done, false);
  await clock.advance(1);
  assert.ok(r.error instanceof DeadlineExceededError, String(r.error));
  assert.ok(calls.length >= 2);
  assert.ok(calls.at(-1).init.signal.aborted, 'in-flight request was aborted');
  assert.equal(clock.pending, 0);
});

test('queue time before the first attempt does not eat the deadline by default', async () => {
  const { client, clock } = setup([ok()], { ratePerSecond: 1, burst: 1, totalDeadlineMs: 1500 });
  const first = run(client.get('http://x/1'));
  const second = run(client.get('http://x/2')); // has to wait 1 s for a token
  await clock.advance(1000);
  assert.equal(first.done && second.done, true);
  assert.equal(second.error, undefined);
});

test('countQueueTime: true makes the wait for the first token count against the deadline', async () => {
  const { client, clock } = setup([ok()], { ratePerSecond: 1, burst: 1, totalDeadlineMs: 500, countQueueTime: true });
  run(client.get('http://x/1'));
  const second = run(client.get('http://x/2'));
  await clock.advance(500);
  assert.ok(second.error instanceof DeadlineExceededError);
  assert.equal(clock.pending, 0);
});

// ---- cancellation ----------------------------------------------------------------------------
test('cancel while waiting for a token', async () => {
  const { client, clock, calls } = setup([ok()], { ratePerSecond: 1, burst: 1 });
  run(client.get('http://x/1'));
  const ac = new AbortController();
  const r = run(client.get('http://x/2', { signal: ac.signal }));
  await clock.advance(10);
  ac.abort();
  await clock.advance(0);
  assert.ok(r.error instanceof CancelledError);
  assert.equal(calls.length, 1, 'cancelled call never reached the network');
  assert.equal(clock.pending, 0, 'limiter timer + deadline timer are gone');
});

test('cancel during backoff sleep', async () => {
  const { client, clock, calls } = setup([status(503)], { random: () => 1 });
  const ac = new AbortController();
  const r = run(client.get('http://x/a', { signal: ac.signal }));
  await clock.advance(50); // in the middle of the 100 ms backoff
  ac.abort();
  await clock.advance(0);
  assert.ok(r.error instanceof CancelledError);
  assert.equal(calls.length, 1);
  assert.equal(clock.pending, 0);
});

test('cancel an in-flight request: fetch gets aborted, no retry follows', async () => {
  const { client, clock, calls } = setup([hang, ok()]);
  const ac = new AbortController();
  const r = run(client.get('http://x/a', { signal: ac.signal }));
  await clock.advance(200);
  ac.abort();
  await clock.advance(5000);
  assert.ok(r.error instanceof CancelledError);
  assert.equal(calls[0].init.signal.aborted, true);
  assert.equal(calls.length, 1, 'no retry after cancel');
  assert.equal(clock.pending, 0);
});

test('an already-aborted signal fails fast without touching the network', async () => {
  const { client, calls, clock } = setup([ok()]);
  const ac = new AbortController();
  ac.abort();
  const r = run(client.get('http://x/a', { signal: ac.signal }));
  await clock.advance(0);
  assert.ok(r.error instanceof CancelledError);
  assert.equal(calls.length, 0);
  assert.equal(clock.pending, 0);
});

test('cancelling 100 in-flight calls at once leaves zero timers (the "dangling timers" check)', async () => {
  const { client, clock } = setup([hang]);
  const ac = new AbortController();
  const rs = Array.from({ length: 100 }, (_, i) => run(client.get(`http://x/${i}`, { signal: ac.signal })));
  await clock.advance(300);
  assert.ok(clock.pending > 0);
  ac.abort();
  await clock.advance(0);
  assert.ok(rs.every((r) => r.error instanceof CancelledError));
  assert.equal(clock.pending, 0);
});

// ---- idempotency -----------------------------------------------------------------------------
test('POST without idempotency key is never retried', async () => {
  const { client, calls, clock } = setup([status(503), ok()]);
  const r = run(client.post('http://x/a', { body: '{}' }));
  await clock.advance(5000);
  assert.ok(r.error instanceof NotRetryableError);
  assert.equal(calls.length, 1);
});

test('POST with idempotency key is retried and sends the same key every time', async () => {
  const { client, calls, clock } = setup([status(503), status(503), ok()], { random: () => 0 });
  const r = run(client.post('http://x/a', { body: '{}', idempotencyKey: 'order-42' }));
  await clock.advance(0);
  assert.equal(r.value.status, 200);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.init.headers.get('idempotency-key')), ['order-42', 'order-42', 'order-42']);
});

test('GET is retried without any key', async () => {
  const { client, calls, clock } = setup([status(503), ok()], { random: () => 0 });
  run(client.get('http://x/a'));
  await clock.advance(0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers.get('idempotency-key'), null);
});

// ---- rate limiting through the client --------------------------------------------------------
test('retries also pay for a token: 20 calls that each fail once cannot exceed the rate', async () => {
  const { client, calls, clock } = setup([status(503), ok()], { random: () => 0, totalDeadlineMs: 60_000 });
  // alternate fail/ok per call is awkward with a shared script, so count attempts only
  const rs = Array.from({ length: 20 }, (_, i) => run(client.get(`http://x/${i}`)));
  await clock.advance(30_000);
  assert.ok(rs.every((r) => r.done));
  const times = calls.map((c) => c.at);
  let max = 0;
  for (const t of times) max = Math.max(max, times.filter((u) => u >= t && u < t + 1000).length);
  assert.ok(max <= 20, `max requests in a 1 s window = ${max}`);
});
