# Crawler

Node 20+ (built-in `fetch`), Python 3.11+ with `pip install aiohttp` for the port. No npm install needed.

| File              | What                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `mock-server.js`  | Local site (200 pages by default, 100-300 ms latency). `PAGES=2000`, `FAIL500=7`, `HANG=12` env vars |
| `crawler.js`      | `sequentialCrawl`, `naiveCrawl`, `boundedCrawl` (worker pool)                                        |
| `bench.js`        | Runs all experiments, writes `results.json` (`node bench.js quick` skips the slow ones)              |
| `naive-stress.js` | `node naive-stress.js 20000`: shows what breaks with the unbounded version                           |
| `crawler.py`      | asyncio + aiohttp + Semaphore port                                                                   |

```
node bench.js
node naive-stress.js 20000
node mock-server.js &           # then:
py crawler.py http://localhost:4000/0 --depth 10 --concurrency 20
```

Results of my runs: `results.json`, `bench-output.txt`, `naive-stress-output.txt`, `python-output.txt`.
