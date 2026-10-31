# Compact forex execution example

The domain-neutral `linked-workbench` supplies the tree grid and chart. The forex
templates configure strategy/order/trade entities, columns, numeric curves,
statuses and event links as authored data. They have no broker integration.
The three authored examples use the same UI in
[Graphite](../examples/applications/forex-execution.agenticview.json),
[Paper](../examples/applications/forex-execution-paper.agenticview.json) and
[Terminal](../examples/applications/forex-execution-terminal.agenticview.json) styles.

Click a strategy to reveal its orders, then an order to reveal its trades. Row
selection loads that strategy's bid/ask history below and highlights the selected
entity. Selecting an order or trade scopes the association lanes to that order.
Search matches ticker, identifiers, statuses and errors while retaining parents.
Roots page independently of expansions; at most 180 grid rows mount at once.
Keyboard arrows move between rows; Right/Left expand/collapse; Enter inspects.

The columns include ticker, strategy/order/trade identity, side, limit/stop-loss
type, quantity, status, bid/ask, spread, start/end times, filled quantity, filled
price and error. Quantities display in millions (`0.5 mio`, `13 mio`); hover for
exact units. Prices use five decimals for non-JPY examples and three for JPY.
Times are UTC with precise timestamps on hover. Sample strategies last seconds
through five days. All prices, identifiers and observations are synthetic.

Solid vertical events mark strategy creation, dashed lines order placement, and
dotted lines trades/fills. Status text accompanies colors. Each order-to-trade
association occupies its own horizontal lane on the same time axis, with separate
order/trade inspection buttons. Large association sets page at eight lanes.

The templates' declarative `simulations` configure **Place demo order** and
**Simulate fill**. These modify a bounded, local inspection overlay only: no
request is sent to an order executor.
Material source row updates discard the overlay; style-only updates preserve it.
Omitting `simulations` leaves an observation UI.

## Supplied data and bounds

Data supplies `entities`, `columns`, `rows`, `series`, `associations`, and optional
`selectedId`, `pageSize` (1–25), `simulations` and `style`. In these templates,
strategies are roots, orders reference strategies, and trades reference orders.
That vocabulary and hierarchy come from the template. Native validation enforces
valid references, unique identifiers, acyclic bounded nesting, scalar fields and
increasing numeric-series times. Trading rules and forex observation validation
belong to the source application, not the generic native component.

The view accepts up to 500 roots, 4,000 rows, eight tracks per root, 256 points per
track and 24,000 points overall, subject to existing HTTP, JSON and live-run budgets.
This bounded example is not a million-row provider adapter. Existing remote
`data-grid` views retain provider-side paging for larger datasets.

Portable templates deliberately contain 12 sample strategies and remain below
the 256 KiB application-definition limit. `scripts/forex-example.ts` exports
`forexLinkedExample()` for the 300-strategy, 1,890-row demonstration. Each of the
two numeric curves uses 12 synthetic samples per root (7,200 scalar points total).
Compact supplied field names and sample counts keep full observations and exact
style saves below the existing 1 MiB request limit.
Publish that generated data through an ordinary component upsert after importing
the chosen template; the authored definition remains separate from observations.
No limit increase or broker credentials are needed.

All three version 1.2 templates are reusable `.agenticview.json` definitions with
numeric strategy IDs, coherent order/trade references and theme-specific Windows
icons. Import one from Settings → Applications or `application_import`; a fresh
request identity creates a new independent card. `application_define` updates an
existing card's saved template without capturing its live observations. See
[portable applications](applications.md) for import/export and source ownership.

## Per-card styles

Open **Style** for theme, literal color, row-height and text-size controls. Changes
preview locally; **Save style to this card** uses the viewer-authenticated exact
component comparison and enabled `data.style` manual field. Stale saves fail rather
than overwrite a newer component. Authored application exports retain the authored
style; export/update the definition explicitly when making a reusable template.

`data.style` accepts `theme` (`graphite`, `paper`, `terminal`), `accent`, `background`,
`panel`, `text`, `muted`, `grid`, generic `kinds`, `statuses` and `tracks` color maps,
`rowHeight` (integer 28–40), and `fontSize` (integer 11–16). These templates use
track names `bid` and `ask`, but the native component accepts arbitrary names and
signed numeric values. Colors are six-digit hex values. There are no CSS strings,
expressions or scripts. Separate cards keep inspection and styles independent.
See the [generic contract](linked-workbench.md) and the
[non-trading build template](../examples/applications/build-evidence.agenticview.json).
Old `execution-workbench` definitions remain readable through a compatibility
adapter; new authored examples use `linked-workbench`.

## Independent Windows cards

In the dedicated desktop canvas, use the card header's **Pop out in independent
window** action. The card opens in a separate process and private WebView profile.
The canvas may close or restart while that process remains open. Each card has a
distinct Windows taskbar identity, window relaunch metadata and an **Open card.lnk**
shortcut retained under the local AgenticView Cards directory. Pin it manually
from its taskbar menu or the shortcut. The application never pins automatically.

Pop-outs share the configured hub and its data; they are independent of the canvas
process, not standalone trading engines. A remote hub may require sign-in in the
new private profile. Loopback previews can use the existing private viewer-key
file bootstrap; raw keys never enter JavaScript, command arguments or shortcuts.
Closing a card window does not archive its card or stop the hub.

For native launchers, `AgenticView.Desktop.exe --url <origin> --card-id <id>
--card-name <label> --data-dir <private-profile>` opens one card. `--open-card`
prepares its durable runtime/profile/shortcut and dispatches the independent
process. `--focus-card <id>` opens the canvas focused on an existing card;
`scripts/start-desktop.ps1 -FocusCardId <id> -Replace` preserves that relaunch intent.
