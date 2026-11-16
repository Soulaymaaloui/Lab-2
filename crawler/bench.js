// Runs every crawler experiment against a freshly spawned mock server and writes results.json.
//   node bench.js            -> full run (takes ~1.5 min because of the sequential + N=1 runs)
//   node bench.js quick      -> skips sequential and N=1
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { sequentialCrawl, naiveCrawl, boundedCrawl } from './crawler.js';

const quick = process.argv[2] === 'quick';
const SEED = 'http://localhost:4000/0';

function withServer(env, fn) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['mock-server.js'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.once('data', async () => {
      try {
        const out = await fn();
        const stats = await fetch('http://localhost:4000/__stats').then((r) => r.json()).catch(() => null);
        resolve({ ...out, server: stats });
      } catch (e) { reject(e); } finally { child.kill(); }
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const summarize = (r) => ({ ...r, errors: r.errors.length, errorSample: r.errors.slice(0, 3) });
const results = {};

// 1-3. 200 pages, whole tree (depth 7 is the deepest level that exists)
if (!quick) {
  console.log('sequential...');
  results.sequential = summarize(await withServer({ PAGES: 200 }, () => sequentialCrawl(SEED, { maxDepth: 10 })));
  await sleep(500);
}
console.log('naive 200...');
results.naive200 = summarize(await withServer({ PAGES: 200 }, () => naiveCrawl(SEED, { maxDepth: 10 })));
await sleep(500);

console.log('naive 2000...');
results.naive2000 = summarize(await withServer({ PAGES: 2000 }, () => naiveCrawl(SEED, { maxDepth: 20 })));
await sleep(500);

// 3. bounded, several N
results.bounded = {};
for (const n of quick ? [5, 20, 50] : [1, 5, 20, 50]) {
  console.log(`bounded N=${n}...`);
  results.bounded[n] = summarize(await withServer({ PAGES: 200 }, () => boundedCrawl(SEED, { maxDepth: 10, concurrency: n })));
  await sleep(500);
}

// 3b. bounded on 2000 pages (the case that breaks the naive version)
console.log('bounded 2000, N=50...');
results.bounded2000 = summarize(await withServer({ PAGES: 2000 }, () => boundedCrawl(SEED, { maxDepth: 20, concurrency: 50 })));
await sleep(500);

// 5. error isolation: page 7 -> HTTP 500, page 12 -> never answers
console.log('error isolation...');
results.isolation = summarize(await withServer({ PAGES: 200, FAIL500: '7', HANG: '12' }, () => boundedCrawl(SEED, { maxDepth: 10, concurrency: 20 })));

writeFileSync('results.json', JSON.stringify(results, null, 2));
console.log('\n| N | Total time | Peak in-flight | Errors | Pages OK |');
console.log('|---|---|---|---|---|');
for (const [n, r] of Object.entries(results.bounded)) {
  console.log(`| ${n} | ${(r.elapsedMs / 1000).toFixed(2)} s | ${r.peakInFlight} | ${r.errors} | ${r.fetched} |`);
}
for (const k of ['sequential', 'naive200', 'naive2000', 'bounded2000', 'isolation']) {
  const r = results[k];
  if (r) console.log(`${k}: ${(r.elapsedMs / 1000).toFixed(2)} s, ok=${r.fetched}, errors=${r.errors}, peak=${r.peakInFlight}, serverPeak=${r.server?.peak}`, r.errorSample ?? '');
}
