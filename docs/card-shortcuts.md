# Card shortcuts

Installation settings may contain `cardShortcuts`, an array of up to 32 shortcuts. Each has a unique stable `id`, a nonempty `label` (160 characters), a target `cardId`, a `chord`, and `mode` (`focus` or `maximize`). Chords must also be unique after normalization. An empty array disables all shortcuts.

```json
{"cardShortcuts":[{"id":"sample-workbench","label":"Workbench","cardId":"synthetic-workbench","chord":"Alt+1","mode":"maximize"},{"id":"sample-investigation","label":"Investigation","cardId":"synthetic-investigation","chord":"Ctrl+Shift+I","mode":"focus"}]}
```

The native settings editor selects from live cards and edits labels, chords and modes. Save validates the complete array before invoking the settings persistence callback. Concurrent changes received while a draft is open require reloading the saved shortcuts. The HUD displays bounded shortcut buttons; unavailable targets remain saved and appear disabled, so a temporary disconnect does not delete configuration.

The same settings are configurable through the authorized MCP operator settings interface. A shortcut is a typed navigation command. It never contains scripts, shell source, machine credentials, connectors or action handlers.

## Supported chords

Modifiers are `Ctrl`, `Alt`, `Shift`, and `Meta`, normalized to that order. Case and surrounding token whitespace are ignored. `Control`, `Option`, `Cmd`, and `Command` are accepted aliases. Duplicate modifiers and unsupported keys are rejected.

Keys are A–Z, 0–9, F1–F12, Enter, Escape, Space, Tab, Backspace, Delete, Home, End, PageUp, PageDown and ArrowUp/Down/Left/Right. Letters, digits and navigation keys require Ctrl, Alt or Meta. Function keys may be unmodified or use Shift alone. For example `shift + control + k` becomes `Ctrl+Shift+K`.

Matching requires the exact modifier set. Repeated, composing, dead-key, AltGraph and already-handled events are ignored. Typing fields ignore function-key-only or Shift-only chords; explicit Ctrl, Alt or Meta chords may match inside fields. Browser or operating-system reserved chords may not reach the app; choose another chord if necessary. The matcher does not prevent default behavior until the host accepts a live target.

## Focus and maximize

The application host must select the target card before framing it. `focus` frames the existing card. `maximize` temporarily presents it as an app view, retaining geometry and camera restoration state; Escape restores the preceding view. The shortcut UI delegates these operations to a typed callback so canvas geometry, gesture cancellation and restoration stay owned by the application.

Settings persist with the existing installation settings. No additional database or per-card live telemetry export is needed.

Use MCP `view_configure` with `operatorToken`, `operation: "shortcuts"` and `input: {"shortcuts": [...]}` to replace only shortcuts while retaining other installation settings. The operator token is the installation viewer key; ingestion and scoped run/session keys do not grant this authority. Manually, use Workspace settings → General → Card shortcuts. Escape or Return to canvas restores the canvas without remounting the card or clearing its draft inputs.
