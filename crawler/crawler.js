// Three crawlers over the same fetch helper:
//   sequentialCrawl  - for + await            (correct, slow)
//   naiveCrawl       - Promise.all everywhere (fast until it falls over)
//   boundedCrawl     - worker pool, N in flight, error isolation, 2 s timeout per page

const HREF = /href="([^"#]+)[^"]*"/g;

/** Same-origin links of an HTML string, resolved against `base`. */
export function extractLinks(html, base) {
  const origin = new URL(base).origin;
  const out = new Set();
  for (const m of html.matchAll(HREF)) {
    try {
      const u = new URL(m[1], base);
      if (u.origin === origin) out.add(u.href);
    } catch { /* ignore malformed href */ }
  }
  return [...out];
}

export function describeError(e) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'timeout';
  return e?.cause?.code ?? e?.message ?? String(e);
}

function newRun(extra = {}) {
  return { fetched: 0, errors: [], inFlight: 0, peakInFlight: 0, ...extra };
}

/** Fetch one page with a hard timeout. Always drains/cancels the body so the socket is freed. */
export async function fetchPage(url, run, { timeoutMs = 2000, fetchFn = fetch } = {}) {
  run.inFlight++;
  run.peakInFlight = Math.max(run.peakInFlight, run.inFlight);
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.text();
  } finally {
    run.inFlight--;
  }
}

function finish(run, t0, visited) {
  return {
    fetched: run.fetched,
    errors: run.errors,
    peakInFlight: run.peakInFlight,
    visited: visited.size,
    elapsedMs: Math.round(performance.now() - t0),
  };
}

// ---------------------------------------------------------------- 1. sequential
export async function sequentialCrawl(seed, { maxDepth = 2, ...opts } = {}) {
  const t0 = performance.now();
  const run = newRun();
  const visited = new Set([seed]);
  const queue = [{ url: seed, depth: 0 }];
  while (queue.length) {
    const { url, depth } = queue.shift();
    try {
      const html = await fetchPage(url, run, opts); // one request at a time
      run.fetched++;
      if (depth < maxDepth) {
        for (const l of extractLinks(html, url)) {
          if (!visited.has(l)) { visited.add(l); queue.push({ url: l, depth: depth + 1 }); }
        }
      }
    } catch (e) {
      run.errors.push({ url, error: describeError(e) });
    }
  }
  return finish(run, t0, visited);
}

// ---------------------------------------------------------------- 2. naive parallel
export async function naiveCrawl(seed, { maxDepth = 2, ...opts } = {}) {
  const t0 = performance.now();
  const run = newRun();
  const visited = new Set([seed]);
  async function visit(url, depth) {
    try {
      const html = await fetchPage(url, run, opts);
      run.fetched++;
      if (depth >= maxDepth) return;
      const fresh = extractLinks(html, url).filter((l) => !visited.has(l));
      fresh.forEach((l) => visited.add(l)); // check + insert in the same sync segment
      await Promise.all(fresh.map((l) => visit(l, depth + 1))); // no limit at all
    } catch (e) {
      run.errors.push({ url, error: describeError(e) });
    }
  }
  await visit(seed, 0);
  return finish(run, t0, visited);
}

// ---------------------------------------------------------------- 3. bounded worker pool
export async function boundedCrawl(seed, { maxDepth = 2, concurrency = 5, ...opts } = {}) {
  const t0 = performance.now();
  const run = newRun();
  const visited = new Set();
  const queue = [];
  const sleepers = []; // resolvers of idle workers (replaces the 10 ms busy-wait of the starter)
  let active = 0;

  const wakeOne = () => sleepers.shift()?.();
  const wakeAll = () => { while (sleepers.length) sleepers.shift()(); };

  function enqueue(url, depth) {
    if (visited.has(url)) return; // check-and-insert is synchronous: no other task can interleave
    visited.add(url);
    queue.push({ url, depth });
    wakeOne();
  }

  async function worker() {
    while (true) {
      const item = queue.shift();
      if (!item) {
        if (active === 0) { wakeAll(); return; } // nothing queued, nobody working -> done
        await new Promise((r) => sleepers.push(r)); // park until work shows up or the crawl ends
        continue;
      }
      active++;
      try {
        const html = await fetchPage(item.url, run, opts);
        run.fetched++;
        if (item.depth < maxDepth) {
          for (const l of extractLinks(html, item.url)) enqueue(l, item.depth + 1);
        }
      } catch (e) {
        run.errors.push({ url: item.url, error: describeError(e) }); // isolated: the pool keeps going
      } finally {
        active--;
        if (active === 0 && queue.length === 0) wakeAll(); // last one out turns off the lights
      }
    }
  }

  enqueue(seed, 0);
  await Promise.all(Array.from({ length: concurrency }, worker));
  return finish(run, t0, visited);
}
