// Focused tests for the token bucket implementation.
// They confirm fair FIFO ordering, token refill behavior, and clean cancellation of waiting requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../src/clock.js';
import { TokenBucket } from '../src/token-bucket.js';
import { CancelledError } from '../src/errors.js';

const bucket = (clock, ratePerSecond = 10, burst = 10) => new TokenBucket({ ratePerSecond, burst, clock });

test('a full bucket serves `burst` callers immediately, no timer needed', async () => {
  const clock = new FakeClock();
  const b = bucket(clock);
  let served = 0;
  for (let i = 0; i < 10; i++) b.acquire().then(() => served++);
  await clock.flush();
  assert.equal(served, 10);
  assert.equal(clock.pending, 0);
});

test('the 11th caller waits ~100 ms (10 tokens/s), not longer', async () => {
  const clock = new FakeClock();
  const b = bucket(clock);
  for (let i = 0; i < 10; i++) b.acquire();
  let served = false;
  b.acquire().then(() => { served = true; });
  await clock.advance(99);
  assert.equal(served, false);
  await clock.advance(1);
  assert.equal(served, true);
});

test('300 concurrent callers are served in FIFO order at 10/s after the burst', async () => {
  const clock = new FakeClock();
  const b = bucket(clock);
  const order = [];
  const times = [];
  for (let i = 0; i < 300; i++) b.acquire().then(() => { order.push(i); times.push(clock.now()); });
  await clock.advance(40_000);
  assert.deepEqual(order, Array.from({ length: 300 }, (_, i) => i), 'strict FIFO');
  // 10 instantly, then one every 100 ms -> the last one at (300 - 10) * 100 ms
  assert.equal(times[9], 0);
  assert.equal(times[299], 29_000);
  // sliding 1 s window never holds more than burst + rate
  let max = 0;
  for (let i = 0; i < times.length; i++) {
    const inWindow = times.filter((t) => t >= times[i] && t < times[i] + 1000).length;
    max = Math.max(max, inWindow);
  }
  assert.ok(max <= 20, `max in a 1 s window was ${max}`);
  assert.equal(clock.pending, 0, 'idle bucket owns no timer');
});

test('tokens never exceed the burst, however long the bucket idles', async () => {
  const clock = new FakeClock();
  const b = bucket(clock);
  await clock.advance(60_000);
  let served = 0;
  for (let i = 0; i < 15; i++) b.acquire().then(() => served++);
  await clock.flush();
  assert.equal(served, 10);
  assert.equal(b.waiting, 5);
  await clock.advance(500);
  assert.equal(served, 15);
});

test('a newcomer cannot jump the queue even if a token is free at that instant', async () => {
  const clock = new FakeClock();
  const b = bucket(clock);
  for (let i = 0; i < 10; i++) b.acquire();
  const order = [];
  b.acquire().then(() => order.push('first-waiter'));
  await clock.advance(100); // first-waiter served, bucket empty again
  b.acquire().then(() => order.push('second'));
  b.acquire().then(() => order.push('third'));
  await clock.advance(300);
  assert.deepEqual(order, ['first-waiter', 'second', 'third']);
});

test('cancelling a waiter removes it, rejects it, and the others keep their order', async () => {
  const clock = new FakeClock();
  const b = bucket(clock);
  for (let i = 0; i < 10; i++) b.acquire();
  const ac = new AbortController();
  const order = [];
  b.acquire().then(() => order.push('a'));
  const cancelled = b.acquire(ac.signal).then(() => 'served', (e) => e);
  b.acquire().then(() => order.push('c'));
  ac.abort();
  assert.ok((await cancelled) instanceof CancelledError);
  assert.equal(b.waiting, 2);
  await clock.advance(200);
  assert.deepEqual(order, ['a', 'c']);
});

test('cancelling the last waiter clears the timer: nothing left dangling', async () => {
  const clock = new FakeClock();
  const b = bucket(clock);
  for (let i = 0; i < 10; i++) b.acquire();
  const ac = new AbortController();
  const p = b.acquire(ac.signal).catch(() => 'cancelled');
  assert.equal(clock.pending, 1);
  ac.abort();
  assert.equal(await p, 'cancelled');
  assert.equal(clock.pending, 0);
});

test('an already-aborted signal rejects immediately and consumes no token', async () => {
  const clock = new FakeClock();
  const b = bucket(clock, 10, 1);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(b.acquire(ac.signal), CancelledError);
  let served = false;
  b.acquire().then(() => { served = true; });
  await clock.flush();
  assert.equal(served, true, 'the single token was still there');
});

test('fractional rates work (1 token every 2 s)', async () => {
  const clock = new FakeClock();
  const b = bucket(clock, 0.5, 1);
  b.acquire();
  let served = false;
  b.acquire().then(() => { served = true; });
  await clock.advance(1999);
  assert.equal(served, false);
  await clock.advance(1);
  assert.equal(served, true);
});
