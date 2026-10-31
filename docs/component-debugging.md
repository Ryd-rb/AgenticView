# Component debugging through MCP

The dedicated desktop exposes authenticated native component diagnostics to agents.
The agent supplies its own `runId`/`runToken`; an ingestion key alone grants no
cross-card authority. The general computer/browser automation ban remains in force.
This interface implements the owner's explicit exception for injected component
actions. It never evaluates agent scripts, accepts selectors, drives another app,
captures images or invokes configured operational actions.

## Workflow

1. Call `component_debug_catalog` for current schemas, limits and CSS properties.
2. Call `component_debug_clients` with your run credentials. Choose a visible
   `clientId`; `lastSeen` identifies the freshest viewer after a desktop restart.
3. Call `component_debug_open` with those credentials, `clientId`, a stable
   `requestId`, and `durationSeconds` (1–7200, default 300).
4. Queue a typed `component_debug_command` with its own stable `requestId`, the
   returned `sessionId` and `command`. Read `component_debug_result` using the
   returned command ID. Queue acceptance does not mean execution succeeded.
5. Call `component_debug_close` when finished. The desktop displays a debugging
   indicator with **Stop debugging**, which disconnects this window immediately.

Clients use viewer authentication and a private ephemeral proof. Agent credentials
never reach the viewer. Standalone windows advertise their own card and descendants;
canvas windows advertise their loaded cards. Hidden windows disconnect the debugger
and pause ordinary readers/rendering. Start a new lease after they return.

| Operation | Command fields | Result |
| --- | --- | --- |
| `navigate` | `mode:focus|maximize|canvas|fit` | Scoped card navigation and frame-opportunity timing |
| `inspect` | optional `componentId`, `includeText`, `limit:1..100` | Mounted components, origin, bounds, visibility and accessible targets |
| `styles` | `componentId`, optional `target`, `properties` | Whitelisted computed styles and bounds |
| `click`, `doubleClick`, `focus` | `componentId`, `target` | Local handler dispatch, focus, scroll and frame timings |
| `input` | `componentId`, `target`, `value` up to 2000 chars | Local native field drafts; no action submission |
| `key` | `componentId`, `target`, supported `key` | Synthetic key handlers; no OS/default Tab navigation |
| `scroll` | `componentId`, optional `target`, bounded `x`,`y` | Native component scrolling |
| `metrics` | none | Bounded frame/long-task/input samples, DOM counts and native renderer counters/heap |
| `profile` | `durationSeconds:1..30` | Renderer JavaScript CPU summary, private artifact ID/hash/size |

A target is `{role?,name?,index?}`. The name is an exact accessible label/title or
bounded text; index is zero-based among matching targets. Inspection includes
reusable target descriptors. Ambiguous, disabled, inactive or clipped targets fail
explicitly. Input uses untrusted DOM events. It cannot create trusted OS input or
establish physical mouse/touch acceptance. Custom frames, links, sensitive inputs,
configuration editors, form submissions and operational grid/action buttons are
excluded. Grid permissions use structural control identifiers, independent of
configurable presentation labels. Use existing typed action APIs for real controls
and their configured confirmations.

Example command after opening a lease:

```json
{
  "operation": "click",
  "componentId": "prices",
  "target": {"role": "button", "name": "Bid", "index": 0}
}
```

The chart must explicitly enable `options.features.seriesToggle` for its legend
to be interactive. Inspect first rather than assuming a visual label is a button.

## Receipts and limits

Each command transitions from `queued` to `running` and then `succeeded`/`failed`.
Disconnect, expiry or restart can produce `cancelled` or `unknown`. Claimed work
is never replayed automatically. Exact retries return the same identity; different
content under the same request ID conflicts. A lost completion may mean the local
UI already changed: read its receipt/state before deciding on another action.

Current bounds are 128 client identities, 512 leases, 256 commands per lease,
2048 commands per installation and 64 KiB per result. Inspection truncates to a
60 KiB client budget. Durable retry identities are retained; reaching a history cap
rejects new work rather than silently evicting identities and enabling replay.
Use a separate installation/data directory for repeatable large test campaigns.
Client liveness expires after 120 seconds; a claimed command has a 90-second
deadline. Idle discovery polls every 5 seconds; active debug polling is 250 ms.

Native CPU profiles are sampled for at most 30 seconds, with at most 16 files of
16 MiB each retained per private desktop profile. Native debug methods are fixed
read-only operations on the trusted main document, with origin/navigation and
message-shape validation. No arbitrary DevTools methods or filesystem paths are
accepted. Keep raw profiles and other installation evidence private.

## Interpreting timing

CPU/RAM are measured independently for the owned native/WebView, server and
provider/load-generator process trees. Working-set sums include shared pages;
private bytes are also reported. CPU is available both as single-core equivalent
and normalized to all logical processors.

Synthetic click receipts separate local dispatch, the first frame opportunity,
the second frame opportunity and MCP round-trip latency. These establish real
renderer scheduling, not compositor presentation or physical input latency.
Passive Event Timing is collected when available for eligible trusted events;
it has a 16 ms threshold and quantized durations. Renderer metrics also expose
layout/style/task durations, DOM counts and JavaScript heap usage. Diagnostic
collection adds overhead; retained profile windows identify sampled periods.
