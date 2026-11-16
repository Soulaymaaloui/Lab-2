// Drives everything in the bonus and writes results.json + lag-*.log
//   node bench.js            (about 2 minutes)
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import autocannon from 'autocannon';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer(env) {
  const child = spawn(process.execPath, ['server.js'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((r) => child.stdout.once('data', r));
  return child;
}
const threads = (pid) => {
  try {
    return Number(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).Threads.Count`]).toString().trim());
  } catch { return null; }
};
const stats = () => fetch('http://localhost:3000/stats').then((r) => r.json());
const lat = (r) => ({
  rps: Math.round(r.requests.average), p50: r.latency.p50, p97_5: r.latency.p97_5, p99: r.latency.p99, max: r.latency.max,
  total: r.requests.total, errors: r.errors, timeouts: r.timeouts, non2xx: r.non2xx,
});

const out = {};

// ---------- Part B: / under load while /cpu is hit 3 times (t = 4, 8, 12 s)
async function partB(label, env, { cpuHits = 3, concurrentCpu = 1 } = {}) {
  const srv = await startServer({ ...env, LAG_LOG: `lag-${label}.log` });
  console.log(`Part B [${label}] ...`);
  const cpuTimes = [];
  const hitter = (async () => {
    for (let i = 0; i < cpuHits; i++) {
      await sleep(4000);
      const t = performance.now();
      await Promise.all(Array.from({ length: concurrentCpu }, () => fetch('http://localhost:3000/cpu').then((r) => r.text()).then(() => cpuTimes.push(Math.round(performance.now() - t)))));
    }
  })();
  const load = autocannon({ url: 'http://localhost:3000/', connections: 100, duration: 16 });
  const [r] = await Promise.all([load, hitter]);
  const s = await stats();
  out[label] = { ...lat(r), cpuRequestMs: cpuTimes, maxLagMs: s.maxLagMs, lagWarnings: s.lagWarnings, rssMB: s.rssMB };
  console.log(out[label]);
  srv.kill();
  await sleep(1500);
}

await partB('baseline-no-cpu', { CPU_MODE: 'inline' }, { cpuHits: 0 });
await partB('inline', { CPU_MODE: 'inline' });
await partB('worker', { CPU_MODE: 'worker', POOL: '6' });
await partB('worker-pool2-burst6', { CPU_MODE: 'worker', POOL: '2' }, { concurrentCpu: 6 });
await partB('worker-pool6-burst6', { CPU_MODE: 'worker', POOL: '6' }, { concurrentCpu: 6 });

await sleep(20000); // let TIME_WAIT sockets from the previous runs drain before the 10k-connection run
// ---------- Part A: 10,000 concurrent connections, 20 s
{
  const srv = await startServer({ CPU_MODE: 'inline', LAG_LOG: 'lag-partA.log' });
  const samples = [];
  const sampler = setInterval(async () => { samples.push({ threads: threads(srv.pid) }); }, 5000);
  const idle = { rssMB: (await stats()).rssMB, threads: threads(srv.pid) };
  console.log('Part A: autocannon -c 10000 -d 20 ...');
  const r = await autocannon({ url: 'http://localhost:3000/', connections: 10000, duration: 20, timeout: 30 });
  clearInterval(sampler);
  const after = await stats().catch(() => null);
  out.partA = { idle, peakThreads: Math.max(...samples.map((s) => s.threads ?? 0)), after, ...lat(r) };
  console.log(out.partA);
  srv.kill();
  await sleep(1500);
}

writeFileSync('results.json', JSON.stringify(out, null, 2));
console.log('\nwritten results.json');
