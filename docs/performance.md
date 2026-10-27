# Initial capacity measurement

The C# / .NET 10 server was exercised on Windows with a separate Node load
generator over loopback HTTP. One viewer continuously drained the SSE stream.

| Workload | Result |
| --- | --- |
| Active agents | 1,000 |
| Operations per request | 10 scalar metric replacements |
| Concurrent requests | Up to 32 |
| Measured requests / operations | 20,000 / 200,000 |
| Measured time, excluding warmup | 9.668 seconds |
| Accepted operations per second | 20,686 |
| Request latency, p50 / p95 | 9.65 / 46.38 ms |
| Registration setup | 13.221 seconds |

Each agent held ten independent metric components. One full update round was
excluded as warmup. The run used the server compiled by the offline source build,
with the same C# application sources as implementation commit `dbb333f`.

This is a bounded synthetic ingestion result, not a sustained service guarantee
or a browser rendering measurement. It excludes concurrent archive compression,
large tables/logs, remote network latency, and power-loss testing. SQLite used
WAL with `synchronous=NORMAL`. Hardware and background load affect results.

Reproduce on a connected development machine with `pnpm build` followed by
`pnpm bench`. `AV_BENCH_AGENTS`, `AV_BENCH_ROUNDS`, and `AV_BENCH_BATCH` select
bounded workload sizes; reports and isolated databases remain under `.task`.

Initial registration was also measured directly inside the service: 100
registrations took 12.387 seconds, including 12.223 seconds in placement.
Replacing repeated nearest-position searches with bounded free-slot placement
reduced the same probe to 0.116 seconds, including 0.017 seconds in placement.
These are stage-counter timings, not sampled stack attribution.
