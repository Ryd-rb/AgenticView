# Project rules

- AgenticView is a public project licensed under MIT.
- The server must be C# on .NET 10. Work builds target Windows x64 with the .NET 10
  SDK and no internet restores; bundle locked NuGet packages and browser assets.
- The hub is self-hosted for one operator, with observation and configured controls. Keep
  installations separate, persist archives locally, and prioritize investigations.
- Agents may configure permanent application cards, typed actions and optional
  confirmations. Execute through owning agents or local connector allowlists;
  never turn browser fields into shell source or expose machine credentials.
  Persist action acknowledgements and history, bind confirmation to configuration
  versions, and never replay uncertain side effects automatically. Keep log tails,
  reader results and DOM rows bounded independently of source size. Grids are
  provider-neutral: accept supplied columns/rows or a bounded paged source, and
  route full added/updated/deleted row(s) to configured actions. Persistence,
  version checks and history belong to the configured adapter; SQLite is optional.
  Million-row tables must use bounded pages and provider-side filtering/sorting,
  never load or mount the full dataset in the browser.
- Keep reusable permanent application definitions in the creating project's
  repository as versioned `.agenticview.json` source. Export authored templates,
  never live telemetry or credentials. Use logical connector bindings and supply
  installation-specific values on import. Support manual and agent import/export.
  Prompt delivery supports inboxes and optional connector-owned webhooks with
  local secrets; confirmations remain configurable per action.
- Managed agent sessions use configured local or SSH connector profiles. Keep
  prompts and scoped reporting credentials out of shell command strings. Persist
  cards, native session identity, bounded output and recovery intent. Resume the
  native session first; hand off retained context and component descriptions when
  replacement is required, truthfully showing the new provider identity. Bound
  automatic recovery and terminate only owned processes on disconnect. Keep the
  original provider/model settings; no default approval or sandbox bypasses.
- SSH machine/account/launcher configuration is available through MCP and manual
  settings. Encrypt saved passwords, never return them in listings, and permit
  account reuse across machines. Do not expire credentials on a schedule; only
  confirmed authentication rejection invalidates the affected binding. Transport
  failures must retain credentials. Prompt for replacement and protect newer
  credentials from delayed rejection reports. Keep passwords out of argv/env.
- Support typed native components and agent-authored views under explicit embed
  rules. Prefer and expand native components so agents rarely need custom HTML.
  Distinguish Built-in components from Custom views with persistent origin labels
  and a separate custom frame. Do not add an LLM dependency for display instructions.
- Use a freeform canvas with nonoverlapping draggable cards, position locks,
  content sizing and manual fixed sizing. Native displays are agent subcards.
- Support mouse, keyboard and touchscreen pinch/tap input. Fit all must frame
  every world card without a fixed zoom-out floor.
- Agents own cleanup. Completed session and monitoring cards archive after a
  configurable delay, default five minutes; permanent launchers remain visible.
  Show a draggable Archived cards browser with restore for review or continued
  session interaction. Keep compressed archives local and settings behind the cog.
- Trusted embeds may execute scripts and load external resources; preserve host
  credential and origin boundaries.
- Publish source code and synthetic examples only. Never commit personal data,
  secrets, real telemetry, private infrastructure details, or local machine paths.
- Keep agent-provided content untrusted. Preserve authentication boundaries and
  validate protocol inputs before rendering or persisting them.
- Keep viewer sign-in across browser/app restarts in the same profile by default,
  with a session-only option and Sign out. Persist protected HttpOnly session
  cookies; never store raw viewer keys in browser storage or page scripts.
- Keep runtime state, local configuration, and task evidence outside tracked files.
- Keep wheel and pinch zoom anchored under the pointer or finger midpoint across
  main-view/card handoffs; never recenter a card during a zoom gesture.
- Chain nested scrolling at bounds. On reversal, reveal obscured children through
  their parent viewports only to recover movement handed outward by the gesture;
  apply independently on both axes. Fresh child input must keep making progress.
- Route captured movement using the current physical hit region, continuing on
  the canvas when a contact leaves a table or card. Keep local contacts alive
  through telemetry. Hold geometry during gestures and passive selected-card
  updates; explicit editor actions may grow a card in either dimension.
- Selection changes input authority and the outer selection indicator, preserving
  component layout, styling, visible controls, and local inspection state.
- Content-sized cards fit table widths within supported bounds. Support manually
  and MCP-configured shortcuts that focus or temporarily maximize a card without
  discarding its state, with a return path to the canvas.
- Show new cards immediately without changing camera zoom or the selected card.
  Start their temporary arrival color on first visibility, including nested cards.
- Timestamp arrival, content updates, completion and task rows. Keep task clocks
  compact: milliseconds for second-scale gaps, seconds for minute-scale gaps,
  minutes for ten-minute-plus gaps, with exact times on hover. Show elapsed task
  durations with the same precision; never invent durations without an observed start.
  Distinguish observed
  receipt times from agent execution times. Use status borders and emphasize the
  archive action for completed cards that remain visible.
- Keep the page within the viewport, with the settings cog fixed at bottom left.
  Put monitoring beside the cog; open its live statistics as a draggable world card.
  Keep monitoring history and counters bounded and its polling paused while hidden.
  Automatically place arrivals around established card geometry without moving
  previously packed cards. Preserve sizes, selected geometry and active gestures.
  Provide explicit Arrange all beside zoom to bin-pack every unlocked world card
  into a compact square-shaped group, preserving locked positions and card sizes.
- Keep the top-left brand to its signal icon and AgenticView name; omit the
  Monitor subtitle and navigation-help text beside the cog. Manual archiving
  shows a quiet accessible Undo notification. Header icons are configurable via
  MCP from the native catalog, including nested cards and portable definitions.
- Default to canvas navigation until a card is explicitly activated. Global
  controls always retain canvas authority. Keep text legible within component bounds.
  Card zoom and pan must stay within content fit and native scroll boundaries.
- Ordinary cards and nested components grow to content without internal scrolling.
  Keep large logs, paged grids and deliberate fixed or constrained views bounded.
- Reuse the monitoring card for a stable provider session identity, with private
  registration proof; resume/handoff retains the managed session card.
- Authorized operator MCP controls can configure the full view, read other cards
  and create standalone native components. Scoped run/session tokens remain scoped.
  Optional context-aware quick-text actions use configured agent inboxes or
  connector allowlists, with bounded intervals, cancellation and explicit failures.
- Use readable working text and strong contrast without increasing fixed card
  dimensions. Avoid forced bitmap layers that soften text under nested transforms.
- Reuse unchanged agent branches and telemetry state; navigation and stats updates
  must not rebuild every card. Keep asset compression/caching separate from SSE.
- Support a dedicated Windows fullscreen window with no system title bar and
  custom minimize, maximize/restore and close controls; reuse the title's signal
  icon and keep desktop dependencies offline-ready.
- Owner preference, 30 October 2026: launch AgenticView in its dedicated desktop
  window for previews and review. After every delivered update, force-reopen it
  with `scripts/start-desktop.ps1 -Replace`, even for an unchanged build, and verify
  visible readiness. Open a browser only when explicitly requested.
- Do not create or run automated image, screenshot, pixel, golden, or framebuffer
  tests. Verify meaningful rendering behavior through non-image contracts; visual
  review is manual.
- Use focused commits and retain unfinished work. Remove only explicitly owned,
  regenerable outputs; never use broad destructive cleanup commands.
