# Native component catalog

Prefer a built-in component whenever it can express the evidence. Agents send
structured data; AgenticView supplies the layout, typography, scrolling, paging
and interaction. No HTML, JavaScript, external chart library or LLM is required.

Call the MCP `component_catalog` tool for the full input schema and bounds.
Every component uses `{id, title, kind, data}` and is published with an `upsert`
operation. Keep the same ID to update an existing subcard.

## Choose a view

| Evidence | Built-in kinds |
| --- | --- |
| Tasks and narrative | `checklist`, `markdown`, `status`, `alert` |
| Application controls | `action-panel`, `log-stream`, `data-grid` ([setup](controls.md)) |
| Measurements | `metric`, `stat-grid`, `gauge`, `progress` |
| Trends and distributions | `chart` (line, area, bar, scatter), `bar-list`, `histogram`, `heatmap`, `breakdown` |
| Investigation evidence | `query`, `table`, `logs`, `timeline`, `trace`, `http` |
| Coding and tools | `code`, `diff`, `tree`, `command`, `comparison`, `stacktrace`, `test-results` |
| Services and schedules | `service-map`, `gantt` |
| References and structured data | `links`, `keyvalue`, `json` |

These are **31 native kinds**. The separate `embed` kind is for agent-authored
views that the native catalog cannot express. Native subcards carry a quiet
**Built-in** label. Embeds carry a persistent **Custom view** label and a warm,
distinct frame, including when execution is paused.

## A task list

```json
{"id":"tasks","title":"Investigation plan","kind":"checklist","data":{"items":[
  {"id":"read","label":"Read the evidence","status":"completed"},
  {"id":"compare","label":"Compare the samples","status":"active","detail":"Checking the differing fields"},
  {"id":"report","label":"Write the findings","status":"pending"}
]}}
```

Tasks always appear first in an agent card. Keep task IDs stable: reordering and
renaming preserve observed timing. Supported states are `pending`, `active`,
`completed` and `blocked`. Markdown checklists receive the same timing treatment.
Elapsed durations use milliseconds for second-scale work, seconds for minute-scale
work and minutes from ten minutes onward. Running labels share one clock and pause
when the view is hidden. Already completed tasks without an observed start show
an unavailable duration instead of inventing one.

## A query and its result

```json
{"id":"query","title":"Sample counts","kind":"query","data":{
  "query":"SELECT category, COUNT(*) AS count FROM synthetic_samples GROUP BY category",
  "source":"Synthetic dataset","state":"success","durationMs":1234,
  "columns":[{"key":"category","label":"Category"},{"key":"count","label":"Count"}],
  "rows":[{"category":"sample","count":42}],"totalRows":1
}}
```

Publish a `running` query with no columns or rows while the producer works, then
update the same component with results or an `error`. AgenticView displays the
reported query; it does not execute it. Commands follow the same observation model:
send `command`, optional `shell`, `directory`, `output`, `exitCode` and `durationMs`.

## A trace

```json
{"id":"trace","title":"Execution","kind":"trace","data":{"spans":[
  {"id":"run","name":"Investigation","startMs":0,"durationMs":1250},
  {"id":"read","parentId":"run","name":"Read samples","startMs":50,"durationMs":750}
]}}
```

Trace times are relative milliseconds. IDs are unique, declared parents must
exist, and cycles are rejected. Query results page at 25 rows, heatmaps at 16 rows,
and traces at 50 spans. Native scroll areas participate in the same nested scroll
handoff as the rest of the card.

## Services and HTTP evidence

```json
{"id":"services","title":"Request path","kind":"service-map","data":{
  "nodes":[{"id":"api","label":"API","state":"active"},{"id":"store","label":"Store","state":"success"}],
  "edges":[{"from":"api","to":"store","label":"Reads"}]
}}
```

Service maps accept up to 100 uniquely identified nodes and 200 directed edges.
Every endpoint must reference a declared node; cycles are allowed. The native
topology lists connections accessibly and pages at 20 services.

Use `http` to report an observed request: `method`, an HTTP(S) `url`, optional
`statusCode` (100–599), `durationMs`, `requestBody` and `responseBody`.
URLs reject user information. This view displays evidence and does not issue a
request, follow the URL or execute response content.

## Failures, tests and intervals

- `stacktrace` accepts an optional exception and message, plus up to 1,000 frames
  containing `method`, optional `file`, positive `line` and `module`. File names
  remain text. Frames page at 50.
- `test-results` accepts up to 1,000 uniquely identified results with a `label`,
  `state` (`passed`, `failed`, `skipped`, `running`, `pending`), optional
  `durationMs` and `detail`. A summary counts every result; rows page at 50.
- `gantt` accepts up to 200 uniquely identified intervals: `label`, Unix-millisecond
  `start`, optional `end`, `group` and `tone`. Ends cannot precede starts. Missing
  ends are shown as in progress; the view has no clock or inferred end time.
  Intervals page at 50.
- `breakdown` accepts up to 100 nonnegative finite `{label, value, tone?}` items
  and an optional unit. It shows relative shares alongside accessible numeric
  values; zero-only data is explicit rather than divided by zero.

All existing request, run-size and component-count limits still apply. The catalog
also bounds list lengths and validates matrix coordinates, numeric ranges,
references and HTTP(S) links. Treat all producer content as untrusted and keep
secrets out of every view.
