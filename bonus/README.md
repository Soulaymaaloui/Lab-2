# Bonus: 10k connections and loop lag

```
npm install
node bench.js              # Part B (before/after worker pool) then Part A (-c 10000 -d 20), ~3 min
node partA-workers.js 6    # cross-check with a multi-threaded load generator (saturates an 8-core box)
```
Server: `CPU_MODE=inline|worker POOL=6 node server.js` (port 3000; `/`, `/cpu`, `/stats`).
Raw outputs: `results.json`, `results-partA-workers.json`, `bench-output.txt`, `lag-*.log`.
