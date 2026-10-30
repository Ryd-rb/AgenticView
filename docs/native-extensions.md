# Configurable charts and native views

These components are built-in typed displays. All labels and details are literal text. They do not evaluate expressions, execute scripts, accept raw CSS, load remote assets or trigger actions. Configuration is available in the same component payload used by MCP and application definitions. Generic component settings can expose approved data paths for manual configuration.

## Charts

Existing `chart` data with `type`, `series`, `xLabel` and `yLabel` continues to work. The optional `options` object adds:

| Option | Meaning |
| --- | --- |
| `xAxis`, `yAxis` | `label`, numeric `min`/`max`, `includeZero`, `visible`, `grid`, 2–10 `ticks`, `format` |
| `legend`, `markers`, `tooltips`, `labels` | Toggle the corresponding display feature |
| `labelWhen`, `tooltipWhen` | Numeric y-value conditions: `operator` (`lt`, `lte`, `gt`, `gte`, `eq`, `between`), `value`, and `upper` for `between` |
| `annotations` | Up to 32 unique `id`, `axis` (`x`/`y`), `value`, optional `end` for bands, `label`, six digit hex `color`, and `dash` |
| `features.seriesToggle` | Enables viewer-local legend toggles when true |
| `features.dataTable` | Enables a viewer-local data inspector when true |

Number `format` accepts `style` (`number`, `percent`, `compact`), 0–8 `decimals`, and literal `prefix`/`suffix`. Percent formatting treats `1` as `100%`. Axis bounds must increase. X domains and x annotations require entirely numeric x values. Mixed or string x values use categories in first-seen order; numeric x values preserve their spacing.

Each series may specify a stable unique `id`, a chart `type`, `color` (`#RRGGBB`), `dash` (`solid`, `dashed`, `dotted`), 1–6 `width`, `marker` (`none`, `circle`, `square`, `diamond`), and `hidden`. Agent-hidden series cannot be revealed by manual legend controls. Points may supply a literal `label`.

Charts accept at most 12 series with 2,048 points each. The plot displays at most 256 evenly sampled points per series, including its endpoints, with a visible sampling notice. Sampling may omit intermediate peaks; use the paged data inspector for reported values. Conditional labels render at most 40 per sampled series. The inspector renders 25 rows per page and resets to the available page after data shrinks. Domains use all reported points, including hidden series, so series toggles retain comparable axes. Viewer toggles never modify published telemetry.

```json
{"id":"duration","kind":"chart","title":"Duration","data":{"type":"line","series":[{"id":"read","name":"Read","color":"#70d6c3","marker":"circle","points":[{"x":0,"y":12},{"x":1,"y":34}]}],"options":{"yAxis":{"label":"Milliseconds","min":0,"max":100},"annotations":[{"id":"budget","axis":"y","value":50,"label":"Budget"}],"labels":true,"labelWhen":{"operator":"gte","value":30},"features":{"seriesToggle":true,"dataTable":true}}}}
```

## Process stepper

`stepper` data contains up to 100 unique `items` with `id`, `label`, `state` (`pending`, `active`, `completed`, `blocked`, `skipped`) and optional `detail`. `orientation` is `vertical` or `horizontal`. `selectedId` must refer to an existing step. `features.select: true` enables viewer-local detail selection. Otherwise all step details appear as static content. Selection falls back to the agent selection, first active step or first step when the selected step disappears. Selecting a step never changes its execution state.

## Bullet comparison

`bullet` data contains `value`, `min` (default 0), `max` (default 100), optional `target`, `label`, `unit`, `format`, and up to 12 `ranges`. Each range supplies unique `id`, strictly increasing `end`, `label`, and optional `tone` (`neutral`, `info`, `success`, `warning`, `error`). Ends must fit the domain. The reported value and target remain visible as text when outside the domain; the display caps their positions and explains the overflow. Its accessible meter exposes the reported value, target and range label.

## Reference accordion

`accordion` data contains up to 100 unique `sections` with `id`, `title`, literal `text`, optional `tone` and initial `open`. `multiple: false` permits one expanded section and rejects multiple initial open sections. `features.expand: false` displays all text statically. It contains no recursive child schemas or executable markup.

All three renderers accept a host `manual: false` ceiling: charts lose manual toggles and inspection, steppers become static, and accordions show all text without expansion controls. Agent feature ceilings still apply when the host permits manual controls.
