# MCP quickstart

Call `ui_guide({"goal":"start"})` for a short next step. It reads static guidance;
it does not execute the suggested tools, register a card, retrieve credentials,
or call a model. Each response stays below 8 KB and includes prerequisites,
numbered steps, `nextCall`, examples and their effects.

| Goal | Use it for |
| --- | --- |
| `create` | Register your card, keep its private proof, publish the plan first |
| `style` | Card icons/layout and typed native component presentation |
| `data` | Small supplied charts or bounded connector-backed queries/grids |
| `debug` | `ui_open`, safe inspected targets and copyable next calls |
| `windows` | Independent header/window icons, native receipts and pop-out limits |
| `templates` | Authored portable definitions, export and local bindings |

Replace every `<...>` placeholder with your own retained value. They are not valid
credentials. Use the configured MCP connection; keep ingestion credentials private.
Registration returns `runId` and `runToken` for that run. A viewer/operator key has
separate explicit installation authority; a run token is not an operator key.

For a new card, read `component_catalog`, call `agent_register` with a retained
request ID and private random registration key, then publish a Markdown plan first.
Sequence 1 applies only when that new run has no previous publish. Retain the
accepted sequence/content; exact retries reuse both. Keep heartbeats current and
archive completed monitoring cards after retaining evidence.

For safe native interaction, call `ui_guide({"goal":"debug"})`. Follow `nextCall`,
copy `nextActionId` as the new action's `requestId`, and choose only an inspected
target's advertised action. Pending means wait for the same command. Unknown
means inspect current state, never automatically replay with a new identity.
Configured operational actions retain their typed permissions and confirmations.

For large data, keep history in an allowlisted provider and request bounded samples
or pages. Never put SQL, shell source, credentials or machine paths into browser
fields. Portable templates contain authored configuration and logical bindings;
installation bindings and live observations stay local. Export does not capture
live telemetry. A native icon configuration receipt also does not prove application
by an open Windows process: read `card_window_icon_status`.
