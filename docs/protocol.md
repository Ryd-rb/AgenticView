# Agent integration

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

Send `POST /api/agents/{runId}/heartbeat` every 15 seconds. Use
`POST /api/agents/{runId}/archive` to retire your card and preserve its current
retained view. Archiving is idempotent. A completed status allows cleanup, and
does not automatically archive under the default settings.

## Bounds

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
