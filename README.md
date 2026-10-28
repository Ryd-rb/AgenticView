# AgenticView

**A calm canvas for live agent work.**

A self-hosted observation hub that brings agent plans, evidence and progress into
one freeform workspace. Follow a run, inspect its children, and keep useful
results in local archives.

C# · .NET 10 · React · MIT

[Get started](#get-started) · [Connect an agent](#connect-an-agent) · [Offline builds](docs/offline-build.md) · [Windows desktop](docs/desktop.md)

## A workspace that stays yours

- **Keep your place.** Pan and zoom around the canvas. Selected cards hold their
  position and size while reports arrive; new runs appear without moving your view.
- **Look closer.** Activate a card to explore its content. Nested tables, logs and
  code scroll within their bounds, with movement continuing through the surrounding
  card and canvas. Mouse, keyboard and touch inputs share the same navigation model.
- **Choose the right view.** Use 25 built-in types: task lists, query results,
  commands, traces, charts, heatmaps, comparisons, code, diffs and more. Native
  components handle display and interaction; custom HTML is an escape hatch with
  a distinct frame and **Custom view** label. See the [native catalog](docs/native-components.md).
- **Follow the work.** Declared child agents stay with their parent. Status colors,
  first-visible arrival cues, timestamps and compact elapsed task durations make
  changes easier to scan. Exact observed times remain available on hover.
- **Keep the evidence.** Inspect, restore or export compressed local archives from
  the bottom-left settings cog. Automatic archiving is optional and off by default.

AgenticView observes work that agents report. It has no LLM dependency and does
not execute their tasks.

## Four simple concepts

| Concept | What it means |
| --- | --- |
| **Run / card** | One registered agent execution, with its own identity, status and live view. |
| **Native subcard** | A typed component inside a run: a plan, metric, table, log, diff or other evidence. |
| **Declared child** | Another run registered with its parent's proof, shown inside the parent card. |
| **Archive** | A compressed snapshot of the retained run, stored locally for later inspection or restoration. |

Arrival, update and completion times describe when reports were observed. Task
rows retain observed start and completion timing as their checkboxes change;
existing work does not acquire an invented history.

## Get started

For connected development, install the **.NET 10 SDK**, **Node.js 24+** and
**pnpm 11.25.0**, then run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

In another terminal, from the same directory and with the same `AV_DATA_DIR`:

```sh
pnpm keys
```

Open [localhost:4317](http://127.0.0.1:4317) and sign in with the viewer key. Give
agents the ingestion key; keep the server's `runSecret` private.

For frontend development, run `pnpm dev` and `pnpm dev:web` in separate terminals.
`pnpm check` and `pnpm test` run the project's checks.

### Build on an offline Windows machine

Prepare an [offline source bundle](docs/offline-build.md) on a connected machine.
It contains the locked NuGet packages and prebuilt browser assets. After
transferring and extracting it on **Windows x64 with the .NET 10 SDK installed**:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-offline.ps1
dotnet app/AgenticView.Server.dll
```

The offline build needs no Node.js or internet package restore. Web changes are
built during bundle preparation. See the guide for key retrieval and verification.

The optional [Windows host](docs/desktop.md) opens a dedicated fullscreen window
with custom controls and the same signal icon as the web title. It requires the
Windows Desktop and WebView2 runtimes; closing the window leaves the server running.

## Connect an agent

Connect through **MCP over Streamable HTTP** at `/mcp`, or use the HTTP API.
MCP exposes `component_catalog`, `agent_register`, `agent_publish`,
`agent_heartbeat` and `agent_archive`.

After [registering a run](docs/protocol.md), send a batch like this to
`POST /api/agents/{runId}/publish`, using the run's private token in an
`Authorization: Bearer <runToken>` header:

```json
{
  "sequence": 1,
  "operations": [{
    "op": "upsert",
    "component": {
      "id": "plan",
      "title": "Current work",
      "kind": "markdown",
      "data": { "text": "- [x] Inspect the inputs\n- [ ] Validate the result" }
    }
  }]
}
```

Batches are atomic and sequenced. Retry an uncertain delivery with the same
sequence and body. The [protocol](docs/protocol.md) covers authentication,
heartbeats, child registration and cleanup. Start from the
[TypeScript client](clients/client.ts) or the [language examples](examples).

## Local by default

The server binds to `127.0.0.1:4317`. `AV_DATA_DIR` selects its local database,
archives and credentials; use separate data directories for separate installations.
Remote access requires an explicit public URL and HTTPS, or an explicit trusted
private-network HTTP configuration. See the [deployment design](docs/design.md).

Viewer access, installation ingestion and individual run writes use separate
credentials. Agent content remains untrusted. Embedded views have a sandboxed,
state-only bridge, and settings can pause them.

Archives preserve retained content, including reported append trimming. They are
snapshots of a run's current evidence rather than an unlimited event history.
Published source and examples contain synthetic data only.

[Architecture and design](docs/design.md) · [Measured workloads and limits](docs/performance.md) · [MIT license](LICENSE)
