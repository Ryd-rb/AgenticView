# Application cards and controls

AgenticView 0.2 adds permanent application cards, configured actions, an agent
inbox, .NET connector workers, filtered log tails and editable grids. The hub
records and routes requests. A connector executes on the machine with access;
machine credentials and executable profiles stay there. Grids are provider-neutral:
they receive columns/rows and call configured actions. No database is required.

## Create a permanent console

Register a run normally. Call MCP `card_configure` with `runId`, `runToken`,
`actions`, and optional `application: {name, description}`. HTTP clients use
`PUT /api/agents/{runId}/controls` with the run token. Applications survive agent
disconnection and hub restart, and ignore automatic stale/archive policies.
Explicit archive/restore still works. Retain run credentials privately for later
agents to resume management.

```json
{
  "application": {"name": "Service console"},
  "actions": [
    {"id":"prompt","label":"Send instruction","kind":"prompt","target":"agent",
     "fields":[{"key":"message","label":"Instruction","type":"multiline","required":true}]},
    {"id":"version","label":"Check SDK","kind":"command","target":"local-tools",
     "handler":"sdk-version","confirmation":"Run the configured SDK version command?"},
    {"id":"tail","label":"Follow log","kind":"logs","target":"local-tools","handler":"service-log"},
    {"id":"read","label":"Read rows","kind":"query","target":"local-tools","handler":"items-read"},
    {"id":"edit","label":"Save row","kind":"edit","target":"local-tools","handler":"items-edit",
     "confirmation":"Persist these row changes?"},
    {"id":"history","label":"Row history","kind":"history","target":"local-tools","handler":"items-history"}
  ]
}
```

Publish native subcards through `agent_publish`. Keep a current task list first
while an agent is building or maintaining the application.

```json
[
  {"op":"upsert","component":{"id":"actions","title":"Actions","kind":"action-panel","data":{"actionIds":["prompt","version"]}}},
  {"op":"upsert","component":{"id":"live-log","title":"Service log","kind":"log-stream","data":{"actionId":"tail","maxRows":500,"pollMs":1500}}},
  {"op":"upsert","component":{"id":"items","title":"Items","kind":"data-grid","data":{"readAction":"read","editAction":"edit","historyAction":"history","keyColumn":"id","versionColumn":"version","pageSize":50,"columns":[{"key":"id","label":"ID"},{"key":"label","label":"Label","editable":true},{"key":"version","label":"Version"}]}}}
]
```

`action-panel` provides buttons/forms with text, multiline prompts, numbers,
selects, toggles and JSON fields. Select a card to use its controls. Confirmations
review the supplied values inline. Visible read-only monitors continue without
selection; hidden/offscreen readers pause. Automatic readers reject command/edit
actions. Refresh actions after changing definitions; failed actions never replay
on refresh.

## Generic row actions

A `data-grid` can receive `rows` directly with its columns, or configure a
`readAction` to fetch pages. `keyColumn` and `versionColumn` are optional. Add
`addAction`, `editAction`, `deleteAction` and `bulkAction` as needed; each names an
agent-defined action of kind `edit`. The grid sends data and waits for an
acknowledgement. The action decides whether to call a service, save a file, update
a database, send a message, or perform another operation.

```json
{"operation":"update","row":{"name":"New value"},"rows":[{"name":"New value"}],"previousRow":{"name":"Old value"},"changes":{"name":"New value"}}
```

Adds/deletes use `operation: "add"` / `"delete"` plus `row` and `rows`. A bulk
callback receives `operation: "bulk"` and the selected full `rows`. Configured
key/version columns additionally supply `rowId` / `expectedVersion`; the adapter
decides their semantics. History callbacks receive the full `row` and optional
`rowId`. Confirmation policy is independently configurable per action.

Return `{row}` for an acknowledged add/update, or `{rows}` for a replacement
snapshot. Successful deletes remove their row after acknowledgement. Remote grids
reload their provider after saves. New telemetry rows replace the local snapshot;
the UI does not invent persistence before an action succeeds.

Process handlers can declare `kind: "edit"`, `input: "json-stdin"` and
`output: "json"`. A fixed script receives the complete row envelope as JSON on
stdin and returns one bounded JSON object on stdout. The same adapter works for
`kind: "query"` / `"history"` / `"logs"`. See the
[generic HTTP-service script](../examples/connector/row-service.py); its service
URL and token remain in the connector's private environment.

## Run a connector

Copy [the synthetic profile](../examples/connector/profile.example.json) into
private local storage. Set the hub origin, a unique connector ID, and a private
random `registrationKey` of at least 32 characters. Supply `AV_INGEST_KEY` in the
environment, or `ingestionKey` in the private profile. Configure paths accessible
to the connector's operating-system account. Windows UNC shares use normal file
permissions; share/database credentials do not enter the hub.
Relative file/database paths and the default process working directory resolve
against the private profile's folder.

```powershell
dotnet app/AgenticView.Server.dll --connector private-connector.json
```

This is the same offline-ready .NET 10 build, with no Node or additional restore.
The worker makes outbound requests, claims one job at a time and retries only its
acknowledgement. `--once` processes one poll for testing. Independent high-volume
sources can use separate connector IDs.

### Optional prompt webhooks

Use the existing agent inbox for polling, or point a prompt action at a connector
handler of type `webhook`. The connector's local profile owns the destination and
secret environment references; the hub never performs arbitrary outbound calls.
Confirmation remains a per-action choice for either delivery method.

```json
{
  "type": "webhook",
  "url": "https://example.com/agent/inbox",
  "signingKeyEnv": "AV_AGENT_WEBHOOK_SIGNING_KEY",
  "bearerTokenEnv": "AV_AGENT_WEBHOOK_BEARER",
  "timeoutSeconds": 10,
  "maxResponseBytes": 65536
}
```

Configure the action as `kind: "prompt"`, target the connector and name this
handler. A profile may explicitly declare `kind: "custom"` for notifications.
Webhook profiles do not execute command/edit/query actions.

Requests contain `schemaVersion`, `invocationId`, `runId`, `actionId`, `kind`,
`input` and `createdAt`. They exclude run/connector keys, claim tokens and the local
profile. `Idempotency-Key` and `X-AgenticView-Invocation-Id` identify the invocation.
With a signing key, `X-AgenticView-Signature` is `sha256=` plus the lowercase
HMAC-SHA256 of `timestamp + "." + rawRequestBytes`; timestamp is the
`X-AgenticView-Timestamp` Unix-seconds header. The receiver should verify the
signature, clock skew and invocation deduplication before accepting a prompt.

Delivery defaults to one attempt. Only receivers that durably deduplicate IDs
should use `idempotent: true` and `maxAttempts` (2–3). Retries preserve identical
body bytes, ID, timestamp and signature. They cover transient 429/502/503/504 and
transport failures. Explicit rejection and redirects never cause a resend.
HTTPS is the remote default; private HTTP requires `allowHttp: true` in the local
profile. Loopback HTTP is available for local development.

A 2xx response acknowledges prompt delivery, including 202; it does not claim the
agent's resulting task finished. Optional response bodies are bounded (default
64 KiB, maximum 256 KiB). Slow/oversized bodies cannot resend an acknowledged
prompt. Unverifiable delivery becomes `unknown`, with no automatic replay.
No additional packages are required for this connector handler.

For reusable application cards, see [portable application definitions](applications.md).

| Local handler | Behavior |
| --- | --- |
| `process` | Fixed executable, argument list and optional working directory. `{field}` substitutes a whole data argument using `ArgumentList`; no shell source is assembled. Use fixed script files for PowerShell/Python adapters. Output drains continuously, retaining 32,768 characters per stream. |
| `log-file` | Fixed UTF-8 local/UNC path, byte cursor, literal filter and severity colors. `maxReadBytes` is 64 KiB–16 MiB, default 1 MiB. Initial requests seek the last window; short partial lines resume with the next request. |
| `sqlite-table` | Fixed database, table, key/version columns, selected columns and operation (`read`, `edit`, `history`). Edits additionally declare writable columns and a history table. Identifiers come from the local profile; values are parameters. |

SQLite is the bundled database adapter. Other databases, service managers and SSH
can use existing agent tools or custom connector adapters with their installed
drivers. These integrations are extension points. Process output normally returns
stdout/stderr; `output: "json"` explicitly uses a JSON result, capped at 128 Ki
characters and 256 KiB of encoded JSON. Declare the profile's action `kind` when
using a process as a data provider or row callback.

## Bounded logs and grids

Source size does not determine browser memory. A log response retains at most
500 entries and approximately 192 KiB of encoded entries; the UI keeps at most
2,000 rows and mounts a small visible window. Overlong lines truncate and overflow
is counted. When producers outrun the tail, it samples retained evidence instead
of promising lossless ingestion. Original logs stay on the source system.

Million-row tables use a configured provider and retain only the current page,
with at most 200 rows. Filtering and sorting are passed to that provider; the
dataset is never downloaded or mounted in full. Cursor navigation history is
bounded too. Ordinary `table` components can opt in with `sourceAction` and
`pageSize`, keeping `rows: []`; editable `data-grid` components use `readAction`.
The provider may report a large `totalRows` without allocating those rows in the
UI. Its indexing, network access and query plan determine source response time.

The optional SQLite adapter uses keyset pagination, bounded
response bytes and 1,024-character text cells. It rejects edits when a complete
snapshot exceeds the budget. Saving compares the expected numeric version,
increments it, and writes before/after snapshots plus invocation ID in the same
transaction. The configured history table is created in the target database on
first edit; its permissions belong to the local profile. Changes made outside
this adapter do not acquire invented history. The UI shows a bounded history page;
connector responses also expose a continuation cursor for custom clients.

Provider-neutral envelopes:

- query `{cursor?,limit,filter?,sort?,columns?}` → `{rows,nextCursor?,totalRows?}`;
- edit `{operation,row?,rows?,previousRow?,changes?,rowId?,expectedVersion?}` → `{row}` or `{rows}` after persistence;
- history `{row?,rowId?,cursor?}` → `{rows,nextCursor?}`;
- logs `{cursor?,filter?,level?}` → `{entries,cursor,bytesRead?,truncated?}`.

Sort entries use `{key,direction: "asc" | "desc"}` with at most four keys.
Use stable cursors with a deterministic tie-breaker. A provider should apply
filter/sort on its source and return only the requested window, not return the
whole dataset for the browser to filter.

## Delivery and trust

Viewer authentication is required to invoke controls. Run tokens configure only
their own card; connector tokens claim only their inbox. The browser receives no
run/connector tokens. Custom views retain their isolated origin. This remains a
single-operator application: its viewer credential now grants control as well as
observation.

Invocations persist their request ID, configuration version, inputs, timestamps
and status. Reusing an ID with different content is rejected. Optional
confirmation is server-enforced and bound to the current definition version;
a changed definition requires a new review. It represents operator intent, not a
second authorization role.

Queued jobs expire after ten minutes. Claimed jobs become `unknown` after two
minutes and never replay automatically. Late acknowledgements may resolve them.
Verify the target before deliberately retrying an uncertain command. The built-in
worker has a 90-second deadline; long work should expose start/status/stop actions.

Agents use MCP `agent_actions_poll` / `agent_action_complete`, or HTTP
`/api/agents/{id}/actions/poll` and `/actions/complete`. Connectors use
`/api/connectors/{id}/poll` and `/complete`. Execute once, keep the claim token
private and retry only the identical acknowledgement. Delivery into a third-party
agent application's chat requires that application's adapter to consume the inbox.

`controls.sqlite` retains manifests and action history separately from display
telemetry. Recent read results are capped at 64 per card; command/edit/prompt
history remains local. Archive/restore retains configuration in this installation.
For a portable backup stop the hub and retain both databases and private connector
profiles. A display archive alone is not a portable connector deployment.
