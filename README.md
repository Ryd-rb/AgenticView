# AgenticView

A self-hosted observability canvas for agents. **C# / .NET 10 server, React web view,
MIT license.**

Start with an empty dark world. Agents connect from different applications and
machines, declare children, and publish live context and visualizations. Pan,
zoom, drag, lock, and resize their cards without overlap. The bottom-left cog
opens a settings card in the world, including compressed archives.

## Features

- MCP over Streamable HTTP and direct HTTP ingestion.
- Nested agent cards with subcards for metrics, charts, tables, Markdown plans,
  code, diffs, logs, timelines, progress, key/value data, JSON, file trees, status,
  and trusted agent-generated HTML views.
- Content sizing and manual fixed sizing, keyboard movement and resizing.
- Mouse, keyboard and touchscreen navigation, anchored pinch zoom, and Fit all
  for widely separated cards. Double-click or double-tap a card to focus it.
- Atomic sequenced batches, exact retries, incremental viewer updates, viewport
  culling, paginated tables, and windowed logs.
- Persisted live state and gzip archives with inspection and export.
- Immediate arrivals with a fading border, stable selection, status colors and
  compact arrival, update, completion and task-list timestamps.
- Separate viewer and registration keys, private run tokens, and parent proofs.
  Agents own cleanup; automatic archiving is optional and disabled by default.

This is an initial implementation. Manual visual acceptance and sustained capacity
validation remain separate. The target is 1,000 agents and 10,000 component updates
per second; measurements must identify their workload and duration.
The [initial capacity measurement](docs/performance.md) exercised 200,000 operations
across 1,000 agents. Browser frame rate remains a separate validation task.

## Build at work without internet

The offline source bundle includes compiled web assets and a local feed containing
every locked NuGet package. Work builds need the **.NET 10 SDK on Windows x64**.

```powershell
# Inside an extracted offline source bundle:
powershell -File scripts/build-offline.ps1
dotnet app/AgenticView.Server.dll

# Another terminal, same directory and AV_DATA_DIR:
dotnet app/AgenticView.Server.dll --keys

# Optional dedicated fullscreen window, with WebView2 Runtime already installed:
app/desktop/AgenticView.Desktop.exe
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317) and enter the viewer key. Give
producers the ingestion key. Keep `runSecret` private. See [offline builds](docs/offline-build.md)
for bundle preparation and verification.
The [Windows desktop host](docs/desktop.md) provides custom window controls;
closing it leaves the hub running. The browser view remains available separately.

## Connected development

Use the .NET 10 SDK, Node.js 24+, and pnpm 11.25.0. Node and pnpm build browser
assets and run development checks.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test
pnpm start
pnpm keys
```

Run `pnpm dev` and `pnpm dev:web` in separate terminals for frontend development.
The Vite server proxies API calls to the C# server.

## Navigate the canvas

| Input | Action |
| --- | --- |
| Mouse drag on background / middle-button drag | Pan |
| Wheel / Ctrl-wheel | Zoom around the pointer |
| Shift-wheel | Pan horizontally |
| F or Home / Fit all | Frame every world card |
| Arrow keys on the canvas | Pan; Shift moves farther |
| + / - / 0 | Zoom in / out / reset around the viewport center |
| Arrow keys on a card header | Move the unlocked card |
| Arrow keys on a resize handle | Resize the card |
| One finger | Pan background, drag a header, or scroll card content |
| Two fingers | Pinch to zoom and move the midpoint to pan |
| Double-click / double-tap a card | Focus it at a readable scale |

Tap buttons and fields normally. Keyboard shortcuts leave text fields and controls
alone. Embedded documents own their internal gestures; use the surrounding canvas
for monitor gestures. Physical touchscreen verification remains a manual check.

## Connect agents

The MCP endpoint is `/mcp`; authenticate with the ingestion key in an
`Authorization: Bearer ...` header. Discover native schemas with `component_catalog`,
then use `agent_register`, `agent_publish`, `agent_heartbeat`, and `agent_archive`.

See the [HTTP protocol](docs/protocol.md), [TypeScript client](clients/client.ts),
and [language examples](examples). A coding agent can publish a plan, modified-file
tree, and diff in one batch, inside its existing card.

Trusted embeds execute scripts and can load external resources. They run in
sandboxed documents with a state-only bridge; the bridge exposes no installation
credentials or command APIs. Settings can pause embedded views.

## Deployment and data

The default bind is `127.0.0.1:4317`. Configure `AV_HOST`, `AV_PORT`, and
`AV_PUBLIC_URL` for remote access behind HTTPS. `AV_ALLOW_HTTP=1` explicitly allows
HTTP on a trusted private network. `AV_DATA_DIR` selects the local database and
credential directory; separate installations use separate data.

Archives preserve the current retained view. Bounded appends report trimmed items;
archives are not an unlimited sample history. SQLite uses WAL with
`synchronous=NORMAL`: ordinary service restarts preserve committed data, while
power-loss guarantees are weaker than `FULL`. Archives remain retained; the
initial interface supports inspection and export.

Repository content is source and synthetic examples. Credentials, real telemetry,
private infrastructure details, and local configuration stay outside version
control. See the [design](docs/design.md) and [MIT license](LICENSE).
