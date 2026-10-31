# Generic linked workbench

`linked-workbench` is a built-in tree grid with linked numeric curves, timestamp
markers and association lanes. Entity kinds, labels, statuses, column fields and
relationships are supplied as data. No entity vocabulary, currency, trading rule
or three-level hierarchy is built into its schema, renderer or server validator.

The [build-evidence template](../examples/applications/build-evidence.agenticview.json)
uses Project → Job → Artifact → Note, signed metrics and its own review phases.
The [forex templates](forex-workbench.md) configure the same component with
strategy/order/trade labels, quantities, prices and statuses. Import either through
Settings → Applications or MCP `application_import`. Agents can also publish a
`linked-workbench` component directly; `component_catalog.linkedWorkbench` and
the generated component schema describe its fields and bounds.

## Data contract

- `entities`: unique `{id,label,plural?,color?,dash?,marker?}` definitions. Dash is
  `solid`, `dash` or `dot`; marker is `circle` or `square`.
- `columns`: `{key,label,fields?,format?,decimals?,smallDecimals?,decimalsField?,scale?,suffix?}`.
  Fields default to `[key]`. Fields `id`, `label`, `kind`, `status`, `time` and
  `endTime` read row metadata; other fields read `row.values`. These are direct
  names, without paths, expressions or scripts. Formats are `text`, `number`,
  `datetime` and `duration`. A two-field duration subtracts the first value from
  the second. Other multiple fields display on separate lines. Numbers divide by
  `scale`, use the supplied decimal precision, and append `suffix`; `smallDecimals`
  applies below one scaled unit. `decimalsField` reads a validated 0–10 precision
  from row values. Datetime cells show compact UTC, with exact times on hover.
- `rows`: `{id,parentId?,kind,label?,status?,time?,endTime?,values}`. Values are
  bounded strings, finite numbers, booleans or null. Kind names refer to configured
  entities. Status identifiers are arbitrary. Parents can have any entity kind;
  the hierarchy must be acyclic. Timestamps are UTC milliseconds; an end requires
  a start and cannot precede it. No business-specific ordering is imposed on parents.
- `series`: `{rowId,tracks:[{id,label,color?,decimals?,points:[{time,value}]}]}`,
  one series collection per root. Numeric values may be positive, zero or negative;
  track sample times strictly increase. Tracks can use different timestamps.
- `associations`: unique `{id,from,to?,label?}` edges between timed rows in the same
  root. Omitting `to` displays an interval ending at the source end or the observed
  chart boundary. Every edge gets a distinct horizontal lane, including multiple
  edges from one source. Select a root for all its links; select a descendant to
  inspect links touching that row or its non-root ancestors.

Optional `title`, `entityLabel`, `searchLabel`, `searchPlaceholder`, `chartLabel`,
`associationLabel` and `emptyLabel` supply visible and accessible wording.
`selectedId` supplies the initial selection. Root paging, ancestor-preserving
search and keyboard expand/select behavior work through any supported depth.

## Presentation and local demonstrations

`style` accepts `theme` (`graphite`, `paper`, `terminal`), `accent`, `background`,
`panel`, `text`, `muted`, `grid`, `rowHeight` (28–40) and `fontSize` (11–16).
`kinds`, `statuses` and `tracks` are maps of configured identifiers to six-digit
hex colors. The editor discovers identifiers from the supplied data. Enable
`configuration.manualFields: ["data.style"]` to allow exact-comparison style saves.
Selection and style updates preserve local expansion and inspection state.

Optional `simulations` configure bounded local child creation with
`{id,label,parentKind,kind,status?,parentStatus?,allowedStatuses?,values?,copyFields?,parentValues?,parentCopyFields?,timeOffsetMs?,message?}`.
An operation finds the nearest selected ancestor with matching `parentKind` and
allowed status. It copies parent values, applies literal values and field copies,
then optionally updates parent values/status. Copy maps contain direct scalar
field names. Simulation rows remain local and are discarded on material source
updates. There are at most 32 local additions, subject to the same depth/row limits.
No simulation sends a request, executes code or invokes a connector. Real commands
use separately configured typed action controls and their existing safety policies.

## Bounds and compatibility

The component accepts 32 entity kinds, 64 columns, 4,000 rows, 500 roots and paths
of at most 16 nodes. Each root has at most eight tracks, each track 256 points,
with 24,000 points overall. There are at most 4,000 associations and 16 local
simulation definitions. Scalar/color/copy maps have at most 64 safe own keys.
Only 180 grid rows and eight association lanes render at once. Request, authored
definition and live-card byte/JSON budgets still apply independently; this is a
bounded supplied-data component. Use provider-side paged grids for larger sources.

Old `execution-workbench` data remains supported by an isolated compatibility
schema and adapter. The adapter translates the old forex fields into the generic
model, then uses the same renderer. New templates and MCP discovery use
`linked-workbench`. Business validation belongs to the authoring application or
its configured connector; native presentation does not validate trading rules.
