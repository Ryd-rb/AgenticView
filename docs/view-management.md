# View management and generated text

Ordinary cards size to their content. Long logs, paged grids, manual fixed sizes
and collision-constrained locked cards keep bounded scroll areas. Selected-card
geometry stays fixed until deselection. Automatic packing places arrivals around
established positions; content growth may find free space for its own unselected,
unlocked card, without moving neighboring cards. **Arrange all** is the explicit
operation that bin-packs all unlocked world cards toward a compact square group,
including manually placed and fixed-size cards. It preserves card dimensions and
locked geometry. Automatic arrivals continue to preserve established positions.

Completed monitoring and managed session cards archive after a configurable review
delay, five minutes by default. Permanent application launchers remain visible.
The **Archived cards** world card opens when archives become available, without
changing the camera or selection. It pages through 25 summaries at a time and
supports review, compressed export and restore. A restored completed card gets a
fresh review delay. Restoring a managed session permits further interaction with
the same session card. Setting `autoArchiveMinutes` to `null`, or
`archiveAfterCompletion` to `false`, disables automatic completion archiving.
Previously saved explicit settings remain in effect.

## Stable native session registration

Managed sessions already retain their monitoring card when resumed or handed off.
External native agents can additionally supply `sessionProvider` and `sessionId`
to `agent_register` or HTTP registration. Retain the same private random
`registrationKey` across reconnects; a public provider session ID is not a secret.
Use a fresh `requestId` for a new registration attempt and retain it for exact
retries. The same provider/session identity and private proof return the existing
run, components, sequence and layout, restoring an archive when necessary.
A new authenticated continuation activates a terminal card for further reporting.
The original request retry remains an exact retry and does not reactivate work.
Changing the proof or parent is rejected. Different provider sessions remain
separate cards.

## Operator MCP capability

Ordinary MCP calls authenticate with the installation ingestion key. Give agents
only their required scope. Cross-card management additionally requires the
installation viewer key as `operatorToken`; ingestion, run and session tokens do
not qualify. An operator agent can inspect and configure the view, but cannot
obtain host credentials or bypass connector allowlists and action confirmations.
Treat full-view content as installation-private.

`view_read` supports `cards`, `card`, `settings`, `archives`, `archive`, `controls`
and `session`. Lists use `offset` and `limit` from 1 to 100. `cardId` selects a
single card; `session` resolves that card's managed session. Individual cards and
archives retain the existing 2 MiB live/decompression limit.

`view_configure` accepts an `operation` and `input`:

| Operation | Input |
| --- | --- |
| `settings` | Complete settings object |
| `arrange` | `{mode: "all" or "automatic", aspectRatio?}` |
| `orphan` | `{requestId, registrationKey, component}` |
| `layout` | `{cardId, layout}` |
| `style` | `{cardId, style: {icon}}` |
| `name` | `{cardId, name}` |
| `publish` | `{cardId, batch: {sequence, operations}}` |
| `controls` | `{cardId, configuration: {actions, application?}}` |
| `archive`, `restore` | `{cardId}` |
| `session` | `{cardId, sessionId, control}` |

An orphan is a standalone typed component in the world, outside an agent
container. It keeps its Built-in or Custom view origin label. Exact creation
retries require identical component content and proof, including after an
interrupted creation. Edit its designated component through `publish`; archive
the card to remove it. Hidden extra components and removal of its designated
component are rejected.

## Optional quick-text actions

The hub does not load an LLM. `quick_text_configure` schedules a configured action
owned by an agent inbox or a connector's allowlisted handler. Actions used for
text generation or optional completion callbacks must have kind `prompt` or
`custom`, a declared JSON field named `context`, and no interactive confirmation.
Configure them only for the intended read-only text operation.

For example, configure an ordinary action, then call:

```json
{
  "runId": "returned-run-id",
  "runToken": "private-run-token",
  "id": "progress-summary",
  "configuration": {
    "actionId": "summarize-progress",
    "target": "title",
    "intervalSeconds": 60,
    "timeoutSeconds": 30
  }
}
```

The owner receives the usual invocation with bounded card identity, status,
context and component/progress summaries in `input.context`. Reporting credentials
are excluded. Complete it with `result: {text: "Short generated summary"}`.
Text is limited to 512 characters; titles use at most 160. Targets are `title`,
`context`, or `component`; the latter creates/updates a Markdown component using
optional `componentId` and `label`. Text remains untrusted display content.

Intervals range from 15 seconds to one day; deadlines from 5 to 120 seconds.
There is at most one outstanding request per configuration, 64 configurations per
card and 512 per installation, with at most four submissions per scheduler tick.
Only active cards start new requests. Configuration and invocation state persist
across restart. Exact invocation identities prevent duplicate delivery; claimed
commands are never replayed after uncertainty.

Failures use bounded backoff and disable the configuration after three failures.
A claimed request that times out disables it immediately as `unknown` for review.
Use `quick_text_settings` for state, error, last text and next due time. Explicitly
configure again to resume. `{enabled:false}` cancels queued delivery and ignores
late results; an already running external action may still finish. Archiving or
changing the action definition cancels the schedule. An optional
`callbackActionId` receives a normal, version-bound invocation containing
`eventType`, `sourceInvocationId`, `cardId` and `text` in its JSON context.
