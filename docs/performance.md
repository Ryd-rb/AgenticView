# Initial capacity measurement

## Monitoring and ingestion pass

An instrumented baseline and candidate were alternated for three paired runs on
Windows, each with 1,000 agents, ten metric replacements per request, up to 32
concurrent requests, one SSE drain, and 100,000 measured operations. A complete
round was excluded as warmup. The source baseline was `ee67c2b`; the instrumented
baseline added counters but retained the prior publish algorithm.

| Paired run | Instrumented baseline ops/s | Candidate ops/s |
| --- | ---: | ---: |
| 1 | 19,590 | 21,136 |
| 2 | 19,543 | 21,184 |
| 3 | 20,017 | 20,811 |
| Median | 19,590 | 21,136 |

The median improvement was **7.9%**; median request p95 was 30.64 ms before and
29.06 ms after. Changes coalesce viewer metadata once per atomic batch, batch
component UPSERTs in the existing transaction, avoid duplicate input-budget
walks, and hash canonical JSON directly as UTF-8. Digest compatibility, atomic
failure, exact retries, persistence and coalesced patches remain covered by
contracts. SQLite WAL and `synchronous=NORMAL` were unchanged.

Bounded production timing counters identified persistence and patch preparation
as significant service phases. In the first controlled comparison, patch queue
preparation fell from 0.0398 to 0.0173 ms per batch. These timings include warmup
and waits; they are not sampled stack attribution. The installed sampler required
elevation and `dotnet-trace` was unavailable, so no CPU-sampling result is claimed.

This remains synthetic loopback ingestion, not browser frame rate or a sustained
production guarantee. Private reports retain exact binaries, symbols, workload,
source identities and each run. Runtime monitoring keeps only 300 history samples
and polls only while its card is visible.

The final build also completed a 100,000-operation confirmation with monitoring
polled once per second: 22,368 operations/s and request p95 26.95 ms, with four
monitoring responses during the measured interval. This short run corroborates
the publish path with monitoring enabled; it does not establish long-duration
dashboard overhead or browser performance.

## Original measurement

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
