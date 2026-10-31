# Compact forex execution example

`execution-workbench` is a native linked tree grid and price/event chart. It has no
broker integration. The three authored examples use the same UI in
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

`demo: true` enables **Place demo order** and **Simulate fill**. These modify a
bounded, local inspection overlay only: no request is sent to an order executor.
Material source row updates discard the overlay; style-only updates preserve it.
Omitting `demo` leaves an observation UI.

## Supplied data and bounds

Data has `rows`, `series`, optional `selectedId`, `pageSize` (1–25), `demo`, and
`style`. Rows are typed `strategy`, `order` or `trade`; strategies are roots,
orders reference strategies, and trades reference orders. Child ticker and
strategy identity must match their parent, and starts cannot precede the parent.
Each series references one strategy and supplies increasing `{time,bid,ask}`
points. Native validation rejects invalid links, duplicate IDs, inverted times,
negative/excess fills and crossed bid/ask quotes.

The view accepts up to 500 strategy roots, 4,000 rows, 256 points per series and
12,000 points overall, subject to the existing HTTP, JSON and live-run budgets.
This bounded example is not a million-row provider adapter. Existing remote
`data-grid` views retain provider-side paging for larger datasets.

Portable templates deliberately contain 12 sample strategies and remain below
the 256 KiB application-definition limit. `scripts/forex-example.ts` exports
`forexExecutionExample()` for the 300-strategy, 1,890-row, 7,200-point demonstration.
Publish that generated data through an ordinary component upsert after importing
the chosen template; the authored definition remains separate from observations.
No limit increase or broker credentials are needed.

All three version 1.1 templates are reusable `.agenticview.json` definitions with
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
`panel`, `text`, `muted`, `grid`, `bid`, `ask`, `strategy`, a strict `statuses` color
map, `rowHeight` (integer 28–40), and `fontSize` (integer 11–16). Colors are six-digit
hex values. There are no CSS strings, expressions or scripts. Separate cards keep
their selection, expansion, drafts and styles independent.

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
