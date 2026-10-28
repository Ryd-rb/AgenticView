# Agent integration

See [Application cards and controls](controls.md) for persistent applications,
configured actions and inbox delivery. These use separate authenticated endpoints
and durable invocation IDs, preserving telemetry batching.

Register with `POST /api/agents/register`, authenticating with the installation
ingestion key as `Authorization: Bearer ...`. Retain a private random
`registrationKey` with the idempotency ID for registration retries.

```json
{"requestId":"execution-id","registrationKey":"YOUR_PRIVATE_RANDOM_RECOVERY_SECRET_AT_LEAST_32_CHARACTERS","agentId":"coding-agent","name":"Implementation agent","role":"Coding","context":"Implementing the evidence reader"}
```

The response contains `runId`, private `runToken`, `sequence`, and
`heartbeatSeconds`. Use the run token for its HTTP writes. Children register with
`parentId` and `parentToken`; these are credentials, not display content.

Publish `POST /api/agents/{runId}/publish`, starting with sequence 1:

```json
{
  "sequence": 1,
  "operations": [
    {"op":"upsert","component":{"id":"plan","title":"Plan","kind":"markdown","data":{"text":"## Implementation\n- [x] Define reader\n- [ ] Validate parser"}}},
    {"op":"upsert","component":{"id":"files","title":"Modified files","kind":"tree","data":{"nodes":[{"id":"src","label":"src"},{"id":"reader","parentId":"src","label":"Reader.cs","detail":"modified"}]}}},
    {"op":"upsert","component":{"id":"diff","title":"Current diff","kind":"diff","data":{"language":"csharp","before":"return source.ToList();","after":"return source.Where(IsRelevant).ToList();"}}}
  ]
}
```

These appear as subcards in the same agent card. Other operations:
`append(componentId,items)`, `remove(componentId)`, `clear`, `context(text)`, and
`status(active|completed|error)`. A batch is atomic. Responses include sequence,
duplicate status, and trimmed count. Retry the identical batch and sequence after
uncertain delivery. Conflicting retries return 409. Serialize writes per run.

The server records Unix-millisecond `createdAt` (arrival), `updatedAt` (accepted
content batch), and first `completedAt` timestamps. Heartbeats and layout changes
do not change content times. `componentTimes` maps component IDs to last accepted
update times. Missing log/timeline `time` values receive an ISO receipt time;
agent-supplied times are preserved. Archives and live patches retain this metadata.

Markdown/checklist `taskTimes` maps component IDs to observed task rows with stable
keys, current `line`, `firstSeenAt`, `updatedAt`, and optional `startedAt`
and `completedAt`. These are report observations, not inferred execution times.
An initially checked row has no invented start; reopening starts a new observed
interval. Fenced code is excluded. Ambiguous deeply indented rows use the component
receipt time in the viewer. Markdown keys follow normalized task text and `line`
is the source line; native checklist keys follow item IDs and `line` is the current
one-based item position. Markdown has at most 1,024 observed tasks; a native
checklist has at most 200. Displayed durations are observed intervals, with an
unavailable marker when no start was reported.

Prefer the [31 native component types](native-components.md) to custom HTML.
The catalog includes semantic query, command, trace and task views as well as
charts, comparisons and distributions. Queries and commands display reported
activity and never execute it. Built-in and custom views retain distinct origin
labels in both live and archived content.

Send `POST /api/agents/{runId}/heartbeat` every 15 seconds. Use
`POST /api/agents/{runId}/archive` to retire your card and preserve its current
retained view. Archiving is idempotent. A completed status allows cleanup, and
does not automatically archive under the default settings.

Archives are reversible. The viewer can restore a card from Settings → Archives,
or `POST /api/archives/{runId}/restore` with viewer authentication. Restoration
keeps the run ID, credentials, sequence, components, ancestry and sizing. The card
returns to its saved position when free, or moves to a nearby free position.
The next valid content publish also restores an archived card automatically;
heartbeats acknowledge its sequence without bringing it back. Invalid writes leave
the archive untouched. Completed/error runs retain their terminal status and accept
only cleanup operations, even after restoration.

New archives retain the last 256 batch digests for exact retries across restarts.
Older archives remain restorable, but their unavailable retry digests cannot be
reconstructed: send the next sequence instead of replaying an old batch. Repeating
the original registration with its private proof returns the existing credentials
and sequence without restoring the card. A restored run leaves the archive list;
archiving it again saves its latest retained view.

Viewer layout controls use `POST /api/layout/pack` with
`{"mode":"all","aspectRatio":1.6}`. All unlocked world cards are packed and
compacted. Mode `automatic` includes every unlocked card and preserves older
valid positions where possible. `automatic` remains in layouts for compatibility;
it no longer excludes manually placed or legacy cards from the default policy.
Before a real drag/resize starts, `POST /api/agents/{id}/layout/manual` reserves
a 30-second gesture reservation without changing position. Final layout PATCH
releases it; abandoned reservations expire. A layout PATCH may set
`resolveOverlap:true` to find a nearby free position if concurrent arrivals
occupied the requested location. Locked cards always retain position.

Content interaction uses the viewer-only endpoint
`POST /api/agents/{id}/layout/interaction` with
`{"active":true,"leaseId":"opaque-view-id"}`. Renew every 10 seconds while contact
or selection continues; leases expire after 30 seconds. Send `active:false` once
both contact and selection end. Admission,
renewal and release are serialized per card. The response is
`{active,leaseId,expiresAt}`, with a null expiry after release. These leases preserve
geometry and layout flags, are independent of manual drag reservations, and release
only the matching view's lease. IDs allow 1–128 ASCII letters/digits or `_ - : .`;
at most 64 simultaneous leases may hold one card.

## Bounds

Viewer-authenticated `GET /api/monitoring` exposes bounded hub statistics, never
component content, context or run credentials. It includes at most 300 one-second
history samples and the 100 most active live agents. Accepted operation counts
exclude exact retries and rejected mutations; Hub rejections do not include HTTP
requests rejected before mutation parsing. Payload sizes are canonical accepted
JSON bytes, excluding transport headers and the MCP envelope. Rates use monotonic
elapsed intervals. Publish latency is a cumulative bucket estimate, with a final
10-second-plus bucket. Stage counters measure elapsed time including waits and
are not sampled CPU attribution. Per-agent counters cover their current live stint.

Requests: 1 MiB, 256 operations. Runs: 64 components, 2 MiB. Appends: 512 items.
Logs and tables retain the newest 2,000 items; timelines retain 1,000. Positive trim
counts mean older items left the retained view. Archives capture that bounded view.

Discover per-kind fields in the [schema](../shared/components.schema.json) or MCP
`component_catalog`. HTTP errors use `{"error":"..."}` and meaningful
400/401/403/409/413/429 status codes. Back off on 429.

## Trusted view bridge

Embeds accept `data.html`, optional `height` (120-1,200), and JSON `state`.
Trusted code can load external libraries and call external services according to
browser rules. It has no same-origin authority over the monitor.

```javascript
addEventListener('agenticview:state', event => {
  const state = event.detail;
  // Update this document's visualization.
});
```

The latest state is also `window.agenticViewState`. State updates travel through
the bridge. Replacing HTML reloads the component; independent navigation loses
the bridge. Archived embeds remain paused. Keep secrets out of HTML and state.
