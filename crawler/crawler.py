"""Python port of the bounded crawler: asyncio + aiohttp + asyncio.Semaphore.

Run the mock first (node mock-server.js), then:
    python crawler.py http://localhost:4000/0 --depth 10 --concurrency 20
"""
import argparse
import asyncio
import re
import time
from urllib.parse import urljoin, urlparse

import aiohttp

HREF = re.compile(r'href="([^"#]+)[^"]*"')


def extract_links(html: str, base: str) -> list[str]:
    origin = urlparse(base).netloc
    out = {}
    for m in HREF.finditer(html):
        u = urljoin(base, m.group(1))
        if urlparse(u).netloc == origin:
            out[u] = None
    return list(out)


async def crawl(seed: str, max_depth: int, concurrency: int, timeout_s: float = 2.0):
    sem = asyncio.Semaphore(concurrency)          # bounds requests in flight, not tasks
    visited = {seed}
    errors: list[tuple[str, str]] = []
    stats = {"ok": 0, "in_flight": 0, "peak": 0}

    async def fetch(session: aiohttp.ClientSession, url: str) -> str:
        async with sem:                           # at most `concurrency` inside this block
            stats["in_flight"] += 1
            stats["peak"] = max(stats["peak"], stats["in_flight"])
            try:
                async with asyncio.timeout(timeout_s):   # hard per-page deadline (3.11+)
                    async with session.get(url) as resp:
                        if resp.status != 200:
                            raise RuntimeError(f"HTTP {resp.status}")
                        return await resp.text()
            finally:
                stats["in_flight"] -= 1

    async def visit(session, url: str, depth: int):
        try:
            html = await fetch(session, url)
        except Exception as e:                    # error isolation: record and carry on
            errors.append((url, type(e).__name__ if not str(e) else str(e)))
            return
        stats["ok"] += 1
        if depth >= max_depth:
            return
        children = []
        for link in extract_links(html, url):
            if link not in visited:               # check + add with no await in between -> atomic
                visited.add(link)
                children.append(visit(session, link, depth + 1))
        await asyncio.gather(*children)

    t0 = time.perf_counter()
    async with aiohttp.ClientSession() as session:
        await visit(session, seed, 0)
    return {
        "elapsed_s": round(time.perf_counter() - t0, 2),
        "ok": stats["ok"],
        "errors": len(errors),
        "peak_in_flight": stats["peak"],
        "visited": len(visited),
        "error_sample": errors[:3],
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("seed", nargs="?", default="http://localhost:4000/0")
    ap.add_argument("--depth", type=int, default=10)
    ap.add_argument("--concurrency", type=int, default=20)
    args = ap.parse_args()
    print(asyncio.run(crawl(args.seed, args.depth, args.concurrency)))
