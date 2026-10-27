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
- Do not create or run automated image, screenshot, pixel, golden, or framebuffer
  tests. Verify meaningful rendering behavior through non-image contracts; visual
  review is manual.
- Use focused commits and retain unfinished work. Remove only explicitly owned,
  regenerable outputs; never use broad destructive cleanup commands.
