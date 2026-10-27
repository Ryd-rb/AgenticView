# AgenticView

A real-time observability workspace for agents, wherever they run.

AgenticView is being designed as a self-hosted MCP server and a responsive web monitor.
Agents report their activity and publish structured displays into a shared view:
metrics, charts, tables, Markdown, logs, code, timelines, and visualizations.

The intended experience starts with an empty dark canvas. Each connected agent
gets a card, orchestrators can declare nested agents, and viewers can pin cards
while the surrounding layout adapts. Finished runs remain available in archives.

## Status

Early design. The server, protocol, SDKs, and web application are not implemented
yet. See the [design brief](docs/design.md) for agreed requirements, proposed
architecture, component families, and the remaining decisions.

The first version serves one operator, observes agents without controlling their
execution, and prioritizes investigations. Separate installations keep unrelated
environments apart. Run archives are persisted locally. Native structured
components and agent-authored embedded views are both part of the design.

## Privacy

This repository contains source code and synthetic examples only. Credentials,
connection details, telemetry, local databases, private investigation material,
and machine-specific configuration belong outside version control.

## License

[MIT](LICENSE) — use, modify, and distribute the project under the license terms.
