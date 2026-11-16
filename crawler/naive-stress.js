// What breaks when the naive Promise.all crawler meets a much bigger site? (PAGES=N node naive-stress.js)
import { spawn } from 'node:child_process';
import { naiveCrawl, boundedCrawl } from './crawler.js';
const pages = Number(process.argv[2] ?? 20000);
const child = spawn(process.execPath, ['mock-server.js'], { env: { ...process.env, PAGES: String(pages) }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => child.stdout.once('data', r));
const show = (name, r) => console.log(name, JSON.stringify({ ...r, errors: r.errors.length, sample: [...new Set(r.errors.map((e) => e.error))] }));
show('naive  ', await naiveCrawl('http://localhost:4000/0', { maxDepth: 30 }));
const s = await fetch('http://localhost:4000/__stats').then((r) => r.json());
console.log('server stats', s);
child.kill();
