// Local mock site: page n links to pages 2n+1 and 2n+2 (a binary tree), 100-300 ms latency.
// Extras compared with the lab's version (needed for the error-isolation task):
//   FAIL500=7,9   -> these pages answer HTTP 500
//   HANG=12       -> these pages never answer
// Server-side stats are exposed on GET /__stats (peak concurrent requests seen by the server).
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const list = (v) => (v ?? '').split(',').filter(Boolean).map(Number);

export function startMock({ port = 4000, pages = 200, fail500 = [], hang = [], minMs = 100, maxMs = 300 } = {}) {
  const stats = { total: 0, active: 0, peak: 0 };
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/__stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(stats));
    }
    const n = Number(path.slice(1)) || 0;
    stats.total++;
    stats.active++;
    stats.peak = Math.max(stats.peak, stats.active);
    let done = false;
    const finish = () => { if (!done) { done = true; stats.active--; } };
    res.on('close', finish);
    if (hang.includes(n)) return; // never respond; 'close' fires when the client gives up
    const links = [n * 2 + 1, n * 2 + 2].filter((x) => x < pages)
      .map((x) => `<a href="/${x}">p${x}</a>`).join(' ');
    setTimeout(() => {
      if (fail500.includes(n)) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        return res.end('boom');
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body>Page ${n} ${links}</body></html>`);
    }, minMs + Math.random() * (maxMs - minMs));
  });
  server.stats = stats;
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4000);
  await startMock({
    port,
    pages: Number(process.env.PAGES ?? 200),
    fail500: list(process.env.FAIL500),
    hang: list(process.env.HANG),
  });
  console.log(`mock on :${port}`);
}
