# Native control presentation

Native control presentation is a bounded typed map. Components use `configuration.controls`; card chrome uses the corresponding card-level map. It controls appearance and placement without introducing scripts, CSS text, event handlers or additional action authority.

Each entry may specify `visible`, `label` (up to 160 characters), `tooltip` (up to 2,000 characters), `appearance` (`icon`, `text`, `both`), `variant` (`quiet`, `primary`), `placement` (`header`, `footer`, `top-left`, `top-right`, `bottom-left`, `bottom-right`), `mode` (`disclosure`, `panel`) and `initiallyOpen`. Unknown identifiers and fields are rejected. Only relevant options apply to a given native control.

The catalog is: `configure`, `header`, `footer`, `title`, `role`, `context`, `agentId`, `times`, `status`, `fit`, `lock`, `collapse`, `archive`, `resize`, `navigation`, `zoomIn`, `zoomOut`, `resetView`, `deactivate`, `scale`, `caption`, `filter`, `refresh`, `add`, `edit`, `delete`, `history`, `evaluate`, `bulk`, `columns`, `pagination`, `legend`, `dataTable`, `stepSelect`, `expand`, `save` and `cancel`.

```json
{"configuration":{"manualFields":["data.unit"],"controls":{"configure":{"label":"Edit display","tooltip":"Adjust the display unit","appearance":"both","placement":"header","mode":"disclosure","initiallyOpen":false},"save":{"label":"Apply display","variant":"primary"},"times":{"visible":false}}}}
```

`configure.visible: false` hides the component settings control. `mode: panel` displays the editor directly; `disclosure` gives it a summary that can be expanded, optionally initially open. Header and top placements appear above component content; footer and bottom placements appear below it. Left and right placements align the editor in normal document flow, so expanded settings contribute to content sizing instead of covering component data. Hidden footer suppresses footer settings; header placement remains available independently of the heading.

Presentation does not grant write permissions. A component without `manualFields` has no settings editor even if `configure.visible` is true. Saves continue to enforce enabled exact field paths, the current component snapshot and normal component validation. Hiding settings does not revoke an already configured adapter or operator capability.

Component header, title and update time can be hidden independently. The Built-in or Custom view origin label remains visible even when the header is hidden. Selection changes permission-disabled state and preserves the same control structure, disclosure state and draft values.

The shared `control(map,id,defaults)` helper merges native defaults with the supplied entry without mutating either. Web native views receive the component map through `ComponentControls`; `useControl` reads a supported entry. Appearance, content, placement and variant helpers use fixed native styles and accessible labels. Renderers must keep existing feature and authorization checks when adding presentation support.

Agent configuration can be published or updated through the existing authorized MCP view interfaces. Portable component definitions may retain authored control maps; they must not contain live credentials or telemetry.

Configure a card using `card_display(runId, runToken, display)` or, with explicit operator authority, `view_configure(operation: "display", input: {cardId, display})`. The producer HTTP equivalent is `PUT /api/agents/{id}/display`. The TypeScript client exposes `configureDisplay(display)`. This updates metadata without consuming a publish sequence, moving the card or changing its action definitions. Supplied `chrome` or `componentLayout` objects replace that map; omitted objects retain their current settings. An empty map restores defaults. Definitions persist across restart and can be authored in portable application manifests.

```json
{"chrome":{"times":{"visible":false},"fit":{"visible":false},"archive":{"label":"Retain later","appearance":"both","placement":"footer"},"navigation":{"placement":"bottom-left"}},"componentLayout":{"mode":"auto","minWidth":200,"gap":12}}
```

Card `header`, `footer`, `title`, `role`, `context`, `agentId`, `times`, `status` and `resize` control visibility. Title, role, context, agent ID and status accept literal labels. Card actions `fit`, `lock`, `collapse` and `archive` support visibility, labels, tooltips, appearance and variants. Their footer/bottom placements move them to the footer; header/top placements keep them in the header. Nested agent headers and archive controls use the same settings. The navigation toolbar can be hidden or placed at any corner (`header`/`footer` mean top/bottom right); `caption`, `scale`, `zoomIn`, `zoomOut`, `resetView` and `deactivate` can be hidden independently. Its layout remains identical across selection. Global canvas controls and Escape remain available.

The former forced internal vertical stack is replaced by responsive `auto` layout, with a 200px minimum item width and 12px gap by default. Compact supporting components and child cards share available width; tables, grids, charts, code, traces and custom frames span a row for readability. Plans precede context, child agents and supporting components in every mode. `mode: "vertical"` deliberately stacks; `mode: "columns"` uses `columns` (1–8, default 2) and allows wide components side by side. Optional `minWidth` is 200–1000px and `gap` is 0–32px. Narrow auto layouts fall back to one column. Expanded editors continue to participate in content sizing. Canvas card placement remains independent and preserves established positions.

Common native affordances also honor component maps: grid filtering, refresh, add/edit/delete, history, evaluation, bulk edit, column visibility, paging and save/cancel; chart legend, data inspector and paging; step selection and accordion expansion. Feature flags and configured actions remain ceilings. Placement aligns controls in their existing native containers; row actions remain with their rows. Arbitrary action-panel action buttons, grid sort headers and log pause/resume keep their existing definitions rather than gaining new identifiers in this catalog.
