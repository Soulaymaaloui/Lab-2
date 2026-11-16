// Part A again, but the load generator itself is multi-threaded (autocannon `workers`),
// to check whether ~1.5k rps was the server's limit or the load tester's.
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import autocannon from 'autocannon';
const workers = Number(process.argv[2] ?? 6);
const srv = spawn(process.execPath, ['server.js'], { env: { ...process.env, LAG_LOG: 'lag-partA-workers.log' }, stdio: ['ignore', 'pipe', 'ignore'] });
await new Promise((r) => srv.stdout.once('data', r));
const threads = () => Number(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${srv.pid}).Threads.Count`]).toString().trim());
const idle = { threads: threads(), rssMB: (await fetch('http://localhost:3000/stats').then((r) => r.json())).rssMB };
let peakThreads = 0;
const t = setInterval(() => { try { peakThreads = Math.max(peakThreads, threads()); } catch {} }, 4000);
const r = await autocannon({ url: 'http://localhost:3000/', connections: 10000, duration: 20, timeout: 30, workers });
clearInterval(t);
const after = await fetch('http://localhost:3000/stats').then((r) => r.json()).catch(() => null);
const res = { workers, idle, peakThreads, after, rps: Math.round(r.requests.average), p50: r.latency.p50, p97_5: r.latency.p97_5, p99: r.latency.p99, max: r.latency.max, total: r.requests.total, errors: r.errors, timeouts: r.timeouts, non2xx: r.non2xx };
console.log(res);
writeFileSync('results-partA-workers.json', JSON.stringify(res, null, 2));
srv.kill();
