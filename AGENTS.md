# Project rules

- AgenticView is a public project licensed under MIT.
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
