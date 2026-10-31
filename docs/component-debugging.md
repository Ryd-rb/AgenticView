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
   `clientId`. For a native measurement run, require `lastSeen` at or after the
   current process creation time in the private `.task/desktop/session.json`;
   an older visible registration is not evidence that the current desktop is ready.
3. Call `component_debug_open` with those credentials, `clientId`, a stable
   `requestId`, and `durationSeconds` (1–7200, default 300).
4. Queue a typed `component_debug_command` with its own stable `requestId`, the
   returned `sessionId` and `command`. Read `component_debug_result` using the
   returned command ID. Queue acceptance does not mean execution succeeded.
5. Call `component_debug_close` when finished. The desktop displays a debugging
   indicator with **Stop debugging**, which disconnects this window, aborts its
   transport and stops subsequent viewport iterations when they observe cancellation.
   A step or frame wait already in progress may finish. An already-started
   read-only native profile can finish its bounded capture/cleanup; stopping
   debugging does not kill the native window or erase retained evidence.

Clients use viewer authentication and a private ephemeral proof. Agent credentials
never reach the viewer. Standalone windows advertise their own card and descendants;
canvas windows advertise their loaded cards. Hidden windows disconnect the debugger
and pause ordinary readers/rendering. Start a new lease after they return.

| Operation | Command fields | Result |
| --- | --- | --- |
| `navigate` | `mode:focus|maximize|canvas|fit` | Scoped card navigation and frame-opportunity timing |
| `viewport` | `zoom:0.001..16`, optional `steps:1..120`, `intervalMs:8..100`, `anchorX:0..1`, `anchorY:0..1`, `profileSeconds:1..30` | Fixed canvas zoom injection, per-step frame opportunities and optional concurrent native CPU/timeline profile |
| `inspect` | optional `componentId`, `includeText`, `limit:1..100` | Mounted components, origin, bounds, visibility and accessible targets |
| `styles` | `componentId`, optional `target`, `properties` | Whitelisted computed styles and bounds |
| `click`, `doubleClick`, `focus` | `componentId`, `target` | Local handler dispatch, focus, scroll and frame timings |
| `input` | `componentId`, `target`, `value` up to 2000 chars | Local native field drafts; no action submission |
| `key` | `componentId`, `target`, supported `key` | Synthetic key handlers; no OS/default Tab navigation |
| `scroll` | `componentId`, optional `target`, bounded `x`,`y` | Native component scrolling |
| `metrics` | none | Bounded frame/long-task/input samples, DOM counts and native renderer counters/heap |
| `profile` | `durationSeconds:1..30` | Renderer JavaScript CPU and native timeline summaries, private artifact IDs/hashes/sizes |

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
Far views retain their component contents instead of replacing them with summary
thumbnails. Their ordinary readers and source updates may pause. Activate or
maximize the intended card with `navigate` before injecting component input;
retained or clipped content alone does not grant input authority.

`viewport` moves the canvas toward the supplied absolute zoom using a bounded
number of synthetic steps. Anchors are normalized viewport coordinates, defaulting
to the center; omitted step count and interval currently default to 60 and 16 ms.
It uses the same scoped lease as card navigation and accepts no selectors or
scripts. Optional `profileSeconds` captures native diagnostics concurrently with
the zoom, rather than sampling an unrelated idle window:

```json
{"operation":"viewport","zoom":0.04,"steps":90,"intervalMs":16,"anchorX":0.5,"anchorY":0.5,"profileSeconds":5}
```

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

Native CPU profiles are sampled for at most 30 seconds, with at most 16 CPU files
and 16 paired timeline sidecars, each at most 16 MiB, per private desktop profile.
The timeline enables only `devtools.timeline`, uses a 4 MiB native buffer and reads
bounded 64 KiB chunks. Completion and stream draining have finite waits; cleanup
ends tracing, closes the stream and removes the event receiver. The response
reports `dataLossOccurred`, or explicit `timelineUnavailable` while preserving
an available CPU profile. Named complete-event counts and durations are bounded;
inclusive durations overlap and must not be added as exclusive CPU time.
No screenshot, image, snapshot, memory-dump or system-trace categories are enabled.
Native debug methods are fixed read-only operations on the trusted main document,
with origin/navigation and message-shape validation. No arbitrary DevTools methods
or filesystem paths are accepted. Raw profiles can contain installation-private
metadata; keep them and other runtime evidence private.

The hour harness `scripts/desktop-soak-debug.ts` uses the shared `startAtUtcMs`
deadline, so a late start does not silently extend a 3600-second campaign. It
cycles clicks across the complete private card manifest, recording unique clicked
cards and missing indices. Every ten steps it fits the canvas and exercises zoom
to 1 and back to 0.04, then maximizes the next card for safe input. The early and
mid-run gesture pairs may request five-second profiles: at most four capture
attempts, yielding at most eight raw CPU/timeline files. There are no separate idle
profiles. Command requests and receipts retain exact identities; an unknown or
transport-uncertain command stops the pass and is never replaced with a new retry.
Closing leases cancels queued work and marks in-flight outcomes unknown. Result
files distinguish the measurement deadline from final cleanup time. Preparing or
type-checking this harness does not run a measurement campaign.

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
