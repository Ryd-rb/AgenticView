# Project rules

- AgenticView is a public project licensed under MIT.
- The server must be C# on .NET 10. Work builds target Windows x64 with the .NET 10
  SDK and no internet restores; bundle locked NuGet packages and browser assets.
- The first version is a self-hosted, single-operator observation hub. Keep
  installations separate, persist archives locally, and prioritize investigations.
- Support typed native components and agent-authored views under explicit embed
  rules. Do not introduce an LLM dependency for interpreting display instructions.
- Use a freeform canvas with nonoverlapping draggable cards, position locks,
  content sizing and manual fixed sizing. Native displays are agent subcards.
- Support mouse, keyboard and touchscreen pinch/tap input. Fit all must frame
  every world card without a fixed zoom-out floor.
- Agents own cleanup. Optional automatic archiving defaults off. Compressed archives
  and settings live behind one bottom-left cog that opens a card in the world.
- Trusted embeds may execute scripts and load external resources; preserve host
  credential and origin boundaries.
- Publish source code and synthetic examples only. Never commit personal data,
  secrets, real telemetry, private infrastructure details, or local machine paths.
- Keep agent-provided content untrusted. Preserve authentication boundaries and
  validate protocol inputs before rendering or persisting them.
- Keep runtime state, local configuration, and task evidence outside tracked files.
- Keep wheel and pinch zoom anchored under the pointer or finger midpoint across
  main-view/card handoffs; never recenter a card during a zoom gesture.
- Chain nested scrolling at bounds. On reversal, reveal obscured children through
  their parent viewports before scrolling them; apply independently on both axes.
- Keep the page within the viewport, with the settings cog fixed at bottom left.
  Automatically bin pack all unlocked cards, favor older positions and close gaps.
  Preserve sizes and active gestures. Provide Arrange all beside zoom.
- Default to canvas navigation until a card is explicitly activated. Global
  controls always retain canvas authority. Keep text legible within component bounds.
  Card zoom and pan must stay within content fit and native scroll boundaries.
- Support a dedicated Windows fullscreen window with no system title bar and
  custom minimize, maximize/restore and close controls; keep desktop dependencies offline-ready.
- Do not create or run automated image, screenshot, pixel, golden, or framebuffer
  tests. Verify meaningful rendering behavior through non-image contracts; visual
  review is manual.
- Use focused commits and retain unfinished work. Remove only explicitly owned,
  regenerable outputs; never use broad destructive cleanup commands.
