# API client (rate limiter + retries + cancellation)

Node 20+, zero dependencies.

```
npm test          # 30 tests on a fake clock, < 1 s
node verify.js    # 100 concurrent get() vs a mock API failing 30 % of the time (~40 s, real clock)
```
`src/client.js` (ApiClient), `src/token-bucket.js`, `src/errors.js`, `src/clock.js` (realClock + FakeClock harness).
Outputs of my run: `verify-output.txt`, `verify-results.json`. Design notes and numbers are in ../REPORT.md section 2.
