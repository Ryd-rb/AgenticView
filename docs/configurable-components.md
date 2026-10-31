# Configuring built-in components

Every component accepts optional `configuration`, so presentation control is shared
across the catalog rather than confined to charts and grids. Publish it through
MCP `agent_publish` (or operator `view_configure`), HTTP, the TypeScript client or
an authored `.agenticview.json` application. `component_catalog` returns the complete
schemas, limits and configuration guidance. No LLM or script evaluation is involved.

```json
{
  "id": "latency", "title": "Latency", "kind": "metric",
  "data": { "value": 185, "unit": "ms" },
  "configuration": {
    "description": "Latest reported latency",
    "tooltip": "The producer owns the measurement",
    "presentation": { "density": "comfortable", "fontSize": 16 },
    "rules": [{
      "when": { "all": [{ "field": "data.value", "op": "gt", "value": 150 }] },
      "effect": {
        "label": "Latency above target", "tooltip": "Investigate the slow path",
        "presentation": { "color": "#ffcc88", "emphasis": "bold" }
      }
    }],
    "manualFields": ["configuration.presentation", "configuration.rules", "data.unit"]
  }
}
```

Shared settings cover labels, descriptions, tooltips, visibility, initial collapse,
text size (12–24), density, alignment, emphasis and literal hex colors. Conditions
combine `all`, `any` and `none` groups of bounded field comparisons: equality,
membership, numeric ranges, literal contains/prefix and empty/nonempty. Component
conditions read `data.*` and optional `context.*`; grid conditions read row columns.
Numeric comparisons do not coerce strings. Operands are required for operators
that use them. Later matching rules override earlier effects property by property.

For list-backed components, `configuration.collection` selects an existing object
collection (`items`, `events`, `buckets`, `frames`, `entries` or `rows`), applies a
condition, stable ordering and a bounded limit. It changes the view without changing
the source. Linked service-map nodes, trace spans and heatmap row labels are excluded
because filtering them independently would invalidate their relationships.

## Compact native GUIs

Set `configuration.presentation` to `{"surface":"plain","density":"compact"}`
on any native component to remove its decorated subcard shell and reduce spacing.
This is shared across text, metrics, tables, grids, form fields, dropdowns, toggles
and the rest of the native catalog. Fields keep native input behavior, readable
labels and focus outlines; grids retain their bounded pages and row separators.
Omitting these options preserves the usual presentation.

Plain components omit the heading by default and retain a small, accessible
Built-in origin marker. Set `configuration.controls.header.visible` to `true` for
the full heading. Custom embeds always retain their distinct frame and Custom view
label. Conditional presentation rules and enabled manual appearance settings can
also select the plain surface.

Use card display `componentLayout: {"mode":"inline","gap":6}` to wrap small
components at their content widths, without the auto layout's 200px column minimum.
Task components still lead the card. Existing vertical, column and auto layouts
remain available for larger views.

Action panels can compose native fields and buttons without another form panel:

```json
{
  "id": "lock", "title": "Workspace lock", "kind": "action-panel",
  "data": {
    "actionIds": ["lock-workspace"], "layout": "inline",
    "buttons": [{ "actionId": "lock-workspace", "icon": "lock", "appearance": "icon", "variant": "bare" }]
  },
  "configuration": {
    "presentation": { "surface": "plain", "density": "compact" },
    "controls": { "caption": { "visible": false }, "refresh": { "visible": false }, "history": { "visible": false } }
  }
}
```

Configure the referenced action through the usual controls API. Its fields supply
text, multiline, number, select, toggle or JSON inputs. `data.buttons` accepts up to
64 uniquely referenced action presentations; `configuration.controls.submit` sets
shared button defaults. Use `appearance` (`icon`, `text`, `both`), native catalog
`icon`, `variant` (`quiet`, `primary`, `bare`), labels and tooltips. Icon-only buttons
retain an accessible name and default tooltip from the action label. Confirmation,
typed input validation, activation, busy state and configuration versions still
apply; presentation never executes an action automatically.

Import the synthetic [compact GUI workbench](../examples/applications/compact-controls.agenticview.json)
for a label, lock control, text field, dropdown, toggle, number field and local grid.
These are composable uses of the shared native controls, rather than separate
component kinds for every visual combination.

## Manual control and persistence

`manualFields` is an exact allowlist; omission disables the settings editor. The
operator activates the card, opens **Configure component**, changes enabled fields
and presses **Save component settings**. Appearance has regular controls, primitive
fields use typed inputs and structured rules/options use an advanced JSON editor.
Grids additionally provide a column chooser; charts provide optional series and
data-table controls. A publisher can disable these via each component's feature
flags. These local exploration controls do not mutate source data. To persist
column visibility use enabled `data.columns` settings and its `hidden` fields.

Manual paths name a `data.*` field or one of the listed editable `configuration`
fields. Object paths and whole arrays are supported; edit a whole array rather than
an array index. A manual change cannot enable its own permission, change component
identity or inject arbitrary CSS/scripts. The server requires viewer authentication,
checks the expected full component, revalidates the result and saves it atomically.
Stale writes return 409. Operator changes preserve the producer's sequence and
retry history, survive restart and appear in archives. A subsequent producer upsert
replaces the component, including its settings. Saved authored application templates
remain separate from runtime settings; update/export the authored template explicitly
when the configuration should be reusable across installations.

## Grids: validation, styling and overrides

Each column can specify `hidden`, `width`, `tooltip` and `constraints`. `keyColumns`
supports 1–32 unique declared columns, including hidden columns. Added/updated/deleted
callbacks retain complete rows; updates retain previous rows, changes and optional
compound `rowKey` and version. Persistence, optimistic concurrency and history remain
the configured adapter's responsibility.

`data.rules` is an ordered list of `{id, when, column?, constraints?, presentation?,
tooltip?}`. Omit `column` to style/constrain every column in a matching row. Conditions
can combine any of the row's columns, including all ten columns of a compound key.
Constraints support string/number/integer/boolean, required/nullability, enumeration,
numeric and text-length bounds, literal prefix and suffix. For example:

```json
{
  "id": "pricing-toggle", "column": "Value",
  "when": { "all": [{ "field": "Key", "op": "eq", "value": "Global.EnablePricing" }] },
  "constraints": { "type": "boolean", "storage": "string", "required": true },
  "presentation": { "color": "#88ddaa" },
  "tooltip": "This setting accepts only true or false"
}
```

`storage: "string"` validates a logical type while preserving string-backed tables.
Other keys can have different types. Boolean text is exactly `true` or `false`;
numeric text uses decimal/exponent notation. Editing a key reevaluates the complete
draft before saving. The server also rejects invalid direct mutation requests before
queueing configured grid actions. Include `componentId` when sharing an action among
grids; the native UI supplies it. Adapters should repeat business validation at the
persistence boundary, including changes from other applications.

```json
{
  "groupBy": ["Instance", "Key"],
  "mandatory": ["Instance"],
  "dimensions": ["Instrument", "Stream", "ActiveSet"],
  "emptyValues": [null, "", "*"],
  "context": { "Instance": "example", "Instrument": "ABC", "Stream": "prices", "ActiveSet": "primary" }
}
```

Set this as `data.precedence`. Dimensions are compared lexicographically in the
declared order: an Instrument override outranks Stream plus ActiveSet. Mandatory
fields also partition groups, preventing different instances from competing.
Context excludes rows addressing another concrete target. Empty representations are
explicit and configurable. Results label each row active, overridden, ineligible or
conflicting, with the reason in text and tooltips. Equal priorities produce a conflict;
the viewer never chooses an arbitrary winner. Multiple concrete targets in an unresolved
context dimension require a context, also displayed as a conflict.

For remote grids this explanation covers the current page; it is not a global winner
claim for a million-row source. Use a configured `evaluateAction` of kind `custom`
for provider-side or cross-table evaluations. Declare JSON action fields `rows` and
optional `precedence`; native inputs also include `componentId`. Its acknowledged
`result.rows` becomes the displayed bounded window. Return scalar evaluation fields
in those rows, then style/tool-tip them with ordinary rules. The action can implement
arbitrary domain logic within its connector's allowlist; the browser executes none.
Reads, filters and sorts stay provider-side for remote sources, and acknowledgements
and confirmations retain the existing invocation history and version checks.

Grid `features` gates column hiding, filtering, sorting, add/edit/delete/bulk/history,
custom evaluation and precedence explanations. The server enforces mutation and
configured action gates. There is no automatic retry of an uncertain side effect.

See [chart, stepper, bullet and accordion options](native-extensions.md), and import
the synthetic [configurable workbench](../examples/applications/configurable-workbench.agenticview.json)
for a working combination of shared configuration and component-specific options.
