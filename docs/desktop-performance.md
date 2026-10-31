# Responsive desktop workloads

AgenticView targets dense professional desktop workflows. The present foundation
combines typed controls, provider-side queries, retained card state and visibility
gates. It does not establish complete WPF, WinForms or DevExpress feature parity,
or a rendering-speed comparison with those frameworks. Qualification needs the
actual trader workloads, adapters and hardware.

## Precise native presentation

Every native component accepts `configuration.presentation`. Alongside surface,
density, color, background, border color, emphasis and alignment, it supports:

| Properties | Values |
| --- | --- |
| `padding`, `margin`, `controlPadding`, `cellPadding` | 0–96 px scalar or `{top?,right?,bottom?,left?}`; omitted edges keep defaults |
| `gap`, `rowGap`, `columnGap` | 0–64 px |
| `controlHeight`, `rowHeight` | 28–96 and 28–120 px respectively |
| `borderWidth`, `borderRadius` | 0–8 and 0–48 px |
| `fontSize`, `lineHeight`, `fontWeight` | 10–32 px, 1–2.5, 100–900 |
| `fontFamily`, `letterSpacing` | `system`, `mono`, `serif`; 0–4 px |
| `minWidth`, `maxWidth`, `minHeight`, `maxHeight` | 0–2400 px; minimum cannot exceed maximum |
| `animation`, `animationDurationMs` | `none` (default) or `subtle`; 0–1000 ms, default 120 when enabled |

Explicit values inherit into native fields, buttons, real table cells and linked
workbench controls. Checkboxes/radios retain their input semantics; virtual logs
size their JavaScript row offsets to the explicit row height and typography. SVG geometry is not rewritten by
typography settings. Explicit maximum dimensions create constrained scroll areas.
There are no arbitrary CSS, script, URL or font-file fields.

Enable manual edits with `manualFields:["configuration.presentation"]`; the
component editor supplies typed controls, per-edge spacing, clear-to-default and
advanced JSON. Zero spacing is a real override. Saves still compare the complete
expected component before applying changes.

New installations default `reducedMotion:true`. The settings switch disables all
motion, and the operating-system reduced-motion preference remains authoritative.
To opt in, allow animations globally and set a component's `animation:"subtle"`.
Static data updates do not animate. Existing explicit installation preferences are
retained on restart.

## Visibility and scheduling

Cards outside the canvas viewport retain mounted local state after first use,
while their content receives no new render commits. Nested cards/components defer
first mounting until intersection and freeze while clipped by parent viewports.
Returning consumes current telemetry. Reader cancellation happens at the visibility
boundary: grids, charts, logs and sessions stop requests and timers while hidden.
Minimized native windows signal inactivity; hidden documents close their telemetry
stream and reconnect for current state when visible. Active captured gestures keep
their existing continuity safeguards.

Zoom retains the actual native views, including curves and grids; distance does
not replace them with summaries. Below 240×160 screen pixels, source updates and
readers pause while the last committed content stays painted. Card cameras,
drafts and inspection state survive. Scrollports in these small previews use
clipping without hundreds of independent scrolling layers; recorded scroll
offsets survive returning to inspection size.

Canvas gestures update the world transform directly. React camera reconciliation,
culling and new content consumption wait until the gesture settles. The separate
decorative grid moves with its own transform. Explicit presentation overrides use
stable attribute flags rather than CSS substring selectors on ancestor styles.
Inactive charts batch opaque vector marks; activating the card restores individual
point titles and inspection targets. Curves scale with the rest of the view.
The browser may skip painting offscreen card boxes with `content-visibility:auto`;
visible far-zoom cards remain eligible. Retained shells refresh layout, maximized
state and input authority independently of frozen component bodies. Switching
cards revokes the previous maximized presentation without losing local drafts.

Browser DOM rendering uses its UI thread. Per-card native pop-outs already own
independent host processes and private WebView profiles. Provider ingestion/query
work runs through configured connectors. The measured fixes here were a bounded
number-formatter cache and visibility suppression; no unbounded thread-per-card
pool is introduced. The native debugger can capture bounded JavaScript profiles
and non-image rendering timelines through the trusted desktop bridge.

## Millions of observations

Raw history belongs to the configured adapter, independently of view-card budgets.
Use provider-side filtering, sorting and cursor paging for grids. Chart `data.source`
is `{readAction,windowMs?,from?,to?,maxPoints?,pollMs?}`. Bounds are window 1 s–24 h,
points 32–2048 per series and polling 250–60000 ms. Explicit from/to must be supplied
together in increasing UTC milliseconds; omission requests a rolling window.

The read action must be a confirmation-free typed query with declared numeric
`from`, `to` and `maxPoints` input fields. The provider returns bounded
`{series,rawPoints?}`. Each series uses the normal chart schema and stays under
the requested point limit. Responses exceeding it fail visibly. A source chart
retains the last successful plot during pending reads and has only one query in
flight, with a 15 s deadline. Hiding cancels it; query callbacks cannot route writes.

Import [the high-rate template](../examples/applications/high-rate-data.agenticview.json)
and bind its logical `data` connector. The
[reference profile](../examples/connector/high-rate-profile.example.json) and
[SQLite adapter](../examples/connector/time-series-service.py) demonstrate generic
stream/time/value observations. Install Python and configure the fixed script,
working directory and database paths locally. Browser fields select no executables,
paths, SQL or credentials. The optional provider is independent of the .NET hub.

To inspect the retained benchmark database, configure a fixed range from 0 to
999999; its timestamps are synthetic milliseconds rather than a current market feed.

The adapter supports batches up to 4096 points, exact batch retries, indexed time
queries and extrema-preserving min/max envelopes. Grid pages stay at 200 rows or
fewer; cursor context binds filter/sort settings. Point/retry-ledger limits are
explicit; the default retention policy rejects excess writes. History deletion
requires the operator's explicit `drop-oldest` policy. This synthetic reference
uses SQLite WAL with NORMAL synchronization; production durability belongs to the
configured provider.

## Measured synthetic pass

The 100-card workload contains 800 native components, 50,000 grid rows, 153,600 chart
points, 7,700 linked rows, 28,800 linked scalar points and 50,000 log entries. Each
measurement excludes a warmup and uses eight update rounds. V8 CPU profiles found
repeated `Intl.NumberFormat` construction as a top hot path; a cache has at most 30
format/precision combinations and never caches values or affixes.

| Case | Median update | p95 update | Scope |
| --- | ---: | ---: | --- |
| Baseline viewport | 210.2 ms | 359.3 ms | 6 visible cards, 48 components |
| Updated viewport | 143.4 ms | 295.0 ms | Same supplied workload; 32% lower median |
| Updated nested cards | 95.8 ms | 261.0 ms | 4 visible nested cards, 32 components; 100 retained sources |
| Historical summary overview | 75.3 ms | 162.0 ms | Superseded rendering behavior; not current far-zoom acceptance |

The original 100 nested-card run exhausted the default Node heap before measurement;
its failure is retained. These are Node 24/happy-dom React development measurements,
with controlled intersections and wire serialization excluded. They include client
parsing/reconciliation, not browser layout/paint, GPU timing, physical input or a
WPF comparison. Heap deltas include GC timing and are not leak measurements.

A separate local Python 3.14/SQLite 3.50 pass retained one million synthetic points:
5.424 s ingestion, 184,352 points/s; eight full-million-window chart queries had
219 ms median and 224 ms p95, returning at most 512 points. Grid queries returned 200 rows.
First/last samples and injected positive/negative spikes were preserved. The test
used the direct adapter API, 4096-point batches and NORMAL synchronization. It
excluded connector process startup, HTTP, browser rendering and an hour-long soak.
The measured rate exceeds a millions-per-hour input target; it is not sustained
production or end-to-end certification.

The old summary overview numbers do not describe the retained full views now used
at far zoom. Native desktop zoom and sustained-load qualification must be measured
separately with the scoped [component debugger](component-debugging.md).

Reproduce the headless update cases with `pnpm exec tsx scripts/bench-card-updates.ts` using
`AV_BENCH_SCENARIO=viewport|nested|overview`, and
`python -B scripts/bench-data-provider.py --output .task/data-bench --points 1000000`. Run the finite passes separately
from compilers and other profilers. Keep output directories, source identities,
CPU profiles and database receipts private and retained for review.
