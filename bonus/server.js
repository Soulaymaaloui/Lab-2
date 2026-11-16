// Event-loop showcase.
//   GET /          awaits a simulated 50 ms I/O call, then answers        (event loop at its best)
//   GET /cpu       fib(35)  inline (CPU_MODE=inline) or in a worker pool (CPU_MODE=worker)
//   GET /stats     rss + loop-lag summary
// Loop-lag monitor (from the lab) writes to stderr and to lag.log.
import http from 'node:http';
import os from 'node:os';
import { appendFileSync, writeFileSync } from 'node:fs';
import { fib } from './fib.js';
import { WorkerPool } from './worker-pool.js';

const PORT = Number(process.env.PORT ?? 3000);
const MODE = process.env.CPU_MODE ?? 'inline';
const POOL = Number(process.env.POOL ?? Math.max(2, os.cpus().length - 2));
const LOG = process.env.LAG_LOG ?? 'lag.log';
const N = Number(process.env.FIB_N ?? 35);

writeFileSync(LOG, `# mode=${MODE} pool=${MODE === 'worker' ? POOL : 0} fib(${N})\n`);
const pool = MODE === 'worker' ? new WorkerPool('./fib-worker.js', POOL) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- loop-lag monitor (expected interval 100 ms)
let last = process.hrtime.bigint();
let maxLag = 0, warnings = 0;
setInterval(() => {
  const now = process.hrtime.bigint();
  const lagMs = Number(now - last) / 1e6 - 100;
  if (lagMs > 20) {
    warnings++;
    maxLag = Math.max(maxLag, lagMs);
    const line = `${new Date().toISOString()} event-loop lag ${lagMs.toFixed(0)} ms`;
    console.warn(line);
    appendFileSync(LOG, line + '\n');
  }
  last = now;
}, 100);

http.createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/cpu') {
    const t = performance.now();
    const result = pool ? await pool.run({ n: N }) : fib(N); // inline: nobody else runs until this returns
    res.end(JSON.stringify({ mode: MODE, result, ms: Math.round(performance.now() - t) }));
  } else if (path === '/stats') {
    res.end(JSON.stringify({ rssMB: Math.round(process.memoryUsage().rss / 1e6), maxLagMs: Math.round(maxLag), lagWarnings: warnings }));
  } else {
    await sleep(50); // simulated I/O
    res.end('ok');
  }
}).listen({ port: PORT, backlog: 32768 }, () => console.log(`bonus server on :${PORT} mode=${MODE}`));
