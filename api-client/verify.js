// Verification harness for the rate-limited API client.
// It starts a real HTTP server, fires concurrent requests, and records how retries, deadlines,
// and cancellation interact under a faulty upstream service.
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { setMaxListeners } from 'node:events';
import { ApiClient } from './src/client.js';

const FAIL_RATE = Number(process.env.FAIL_RATE ?? 0.3);
const N = Number(process.env.N ?? 100);

// ---- mock API: records the arrival time of every request
const arrivals = [];
const server = http.createServer((req, res) => {
  arrivals.push(performance.now());
  const r = Math.random();
  if (r < FAIL_RATE / 3) { res.writeHead(429, { 'Retry-After': '1' }); return res.end(); }
  if (r < (2 * FAIL_RATE) / 3) { res.writeHead(503); return res.end(); }
  if (r < FAIL_RATE) return; // hang: never answer, the client has to abort
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
});
await new Promise((r) => server.listen(0, r));
const url = `http://127.0.0.1:${server.address().port}/thing`;

const activeTimers = () => process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
const maxInWindow = (times, w = 1000) => {
  let max = 0, j = 0;
  for (let i = 0; i < times.length; i++) {
    while (times[i] - times[j] >= w) j++;
    max = Math.max(max, i - j + 1);
  }
  return max;
};
const tally = (results) => {
  const t = {};
  for (const r of results) {
    const k = r.status === 'fulfilled' ? 'OK' : r.reason.name;
    t[k] = (t[k] ?? 0) + 1;
  }
  return t;
};

async function scenario(label, { cancelAfterMs, totalDeadlineMs = 5000 } = {}) {
  arrivals.length = 0;
  const client = new ApiClient({ ratePerSecond: 10, burst: 10, attemptTimeoutMs: 1000, totalDeadlineMs, maxRetries: 3 });
  const ac = new AbortController();
  setMaxListeners(Infinity, ac.signal); // 100 calls share one signal: expected, not a leak
  const t0 = performance.now();
  if (cancelAfterMs) setTimeout(() => ac.abort(), cancelAfterMs).unref();
  const results = await Promise.allSettled(Array.from({ length: N }, async () => {
    const res = await client.get(url, { signal: ac.signal });
    await res.text();
  }));
  const elapsed = (performance.now() - t0) / 1000;
  const times = [...arrivals].sort((a, b) => a - b).map((t) => t - t0);
  await new Promise((r) => setTimeout(r, 50)); // let finally-blocks settle
  const out = {
    label,
    callers: N,
    elapsedS: +elapsed.toFixed(2),
    outcomes: tally(results),
    attemptsReachingServer: arrivals.length,
    totalDeadlineMs,
    retries: cancelAfterMs ? null : arrivals.length - N,
    maxRequestsIn1sWindow: maxInWindow(times),
    activeTimeoutHandlesAfterRun: activeTimers(),
  };
  console.log(JSON.stringify(out, null, 2));
  return out;
}

const report = [];
report.push(await scenario('full run (no cancel)'));
report.push(await scenario('deadline raised to 30 s', { totalDeadlineMs: 30_000 }));
report.push(await scenario('cancel at t=2.5 s', { cancelAfterMs: 2500 }));

server.closeAllConnections();
server.close();
await new Promise((r) => setTimeout(r, 100));
console.log('Timeout handles after server.close():', activeTimers(), '| all active resources:', process.getActiveResourcesInfo());
writeFileSync('verify-results.json', JSON.stringify(report, null, 2));
