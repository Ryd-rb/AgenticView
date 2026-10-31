# Windows desktop window

AgenticView.Desktop opens the existing AgenticView server in a dedicated,
borderless WebView2 window. It starts fullscreen on the pointer's monitor,
including the taskbar area. The top-right web controls minimize, restore or enter
fullscreen, and close the native window. F11 also toggles fullscreen. In restored
mode the custom drag area moves the window and the outer edges resize it.

The host requires Windows x64, .NET 10 Windows Desktop Runtime, and Microsoft Edge
WebView2 Runtime. The .NET 10 Windows SDK supplies the build targeting pack. No
installer, system setting, browser extension, or LLM is involved. The server is a
separate process and closing the window keeps it running.
The native window and task switcher reuse the monitor title's signal icon.

## Build and launch

The offline bundle builds both server and desktop host from locked packages and
bundled browser assets. During development, restore the desktop project from a
local feed containing its locked Microsoft.Web.WebView2 package, then publish:

```powershell
dotnet restore src/AgenticView.Desktop/AgenticView.Desktop.csproj --source <local-feed> --locked-mode -p:NuGetAudit=false
dotnet publish src/AgenticView.Desktop/AgenticView.Desktop.csproj --no-restore --no-self-contained -c Release -o dist/desktop
dotnet run --project tests/AgenticView.Desktop.Contracts -c Release
dotnet dist/desktop/AgenticView.Desktop.dll --diagnose
# Start the validated isolated server first, then launch one visible window:
powershell -File scripts/start-desktop.ps1
```

The launcher stages a hashed copy under ignored task storage, checks runtime and
server prerequisites, and retains a relaunch script, process identity, logs, and
diagnostics. Repeated launches reuse a matching live host unless `-Replace` is
supplied. `-Replace` forces a fresh visible window even for the same build, stopping
only the previously recorded process after matching its PID, creation time, command
line and private profile. Use it after each delivered update. The host also locks
its profile to prevent concurrent windows from sharing it. It never closes
unrelated windows or processes.

For a bounded passive input diagnosis, set `AV_INPUT_TRACE=1` before launching.
For ten minutes the trusted main document may send up to 4,096 numeric gesture
records to the staged host's private stdout log. Records contain fixed event
labels and numeric coordinates, scroll offsets, routing and geometry measurements, never panel
text or credentials. The host validates the document, shape and numeric bounds;
diagnostic messages grant no window actions. Relaunch with `AV_INPUT_TRACE=0`
to disable tracing. The launcher treats trace mode as part of host identity.

`--url` defaults to `http://127.0.0.1:4317/`. Only HTTPS or loopback HTTP is
accepted; credentials, queries and fragments are rejected in launch URLs.
`--data-dir` selects a local private WebView profile separate from the system
browser. The staging launcher always uses its checkout's ignored desktop profile.
The launcher discovers the matching owned loopback preview's private viewer-key
file and opens it signed in. It checks the preview's live process, authority,
bounded staging paths and absence of links before handing only the file path to
the native process. `-ViewerKeyFile` can explicitly select a plain private local
file inside the checkout. The native option is `--viewer-key-file`; it is accepted
only for loopback URLs, reads at most 1 KiB and rejects links, network paths and
alternate data streams. Without a key file the normal web login remains available.

Before navigation the native host exchanges the key at `/api/login` using a
loopback HTTP client with redirects and proxies disabled. It imports only the
`av_session` cookie into the private WebView profile, with HttpOnly, Strict
SameSite and the URL's Secure setting. `--diagnose` never reads the token or sends
a login request. Never put viewer or ingestion keys into command lines, injected
JavaScript, logs or launch URLs; only the private file path is passed to the host.

Manual sign-in defaults to **Keep me signed in on this device**, retaining a
one-year signed session cookie in this private WebView profile. Unchecking it
uses a browser-session cookie with a 12-hour server limit. **Settings → General →
Sign out** clears that profile's cookie. A launcher explicitly configured with a
viewer-key file signs in again when reopened; the file remains installation-owned.
Keep the same `--data-dir` and server origin to reuse a saved sign-in. The raw
viewer key is never saved in JavaScript or browser local storage.

## Window bridge

Only the configured top-level document receives the frozen marker:

```javascript
window.agenticViewDesktop // { version: 1, platform: 'windows' }
window.chrome.webview.postMessage({ type: 'agenticview:window', action: 'minimize' })
```

Supported actions are `minimize`, `maximize`, `close`, `drag` and `fullscreen`.
`maximize` and `fullscreen` toggle restored/fullscreen state. The host sends
`{ type: 'agenticview:window-state', state }` with `fullscreen`, `normal`,
`minimized` or `maximized` after navigation and state changes.

The host verifies the sender and current main document's scheme, host, port and
exact path before accepting bounded JSON commands. It does not subscribe to frame
messages. Agent embeds retain their sandbox without same-origin permission, so
they cannot use the parent bridge. Top-level external navigation, new windows,
downloads and permissions are denied. Browser menus, developer tools, accelerator
commands and browser zoom are disabled so the application owns canvas gestures.
There are no exposed native host objects or shell-opening commands.

Security follows Microsoft's [WebView2 security guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security).
The [pinned stable SDK](https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4258.31)
is retained in the offline package feed; the installed browser runtime is separate.
Contract checks cover URL policy, trusted document boundaries, malformed commands
and navigation races. They neither create a window nor inspect images. Manual
window review remains separate.


## Independent card windows

Use **Pop out in independent window** in a desktop card header. The native host
creates a separate process, private browser profile and taskbar identity for that
card. Its local runtime and relaunch shortcut remain available after the canvas
closes. Pin the running card manually from its taskbar menu; no automatic pin is
performed. The card continues to use its configured hub, with protected sign-in
cookies in its own profile. Loopback previews can reuse the private key-file
bootstrap; remote profiles sign in independently.

`--card-id` / `--card-name` open a scoped window, `--open-card` prepares and launches
the durable card runtime, and `--focus-card` opens the canvas on a requested card.
Only the trusted top-level document can request a pop-out; embedded frames cannot
select executables, arguments, profiles or credentials. Native launch arguments
use a fixed allowlist and process argument arrays rather than shell source.

Windows integration sets an explicit window and shortcut AppUserModelID together
with paired [relaunch command and display-name properties](https://learn.microsoft.com/en-us/windows/win32/properties/props-system-appusermodel-relaunchcommand),
following the [window property store contract](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shgetpropertystoreforwindow).
See [the forex example](forex-workbench.md) for the linked UI and style controls.

### Configure Windows icons through MCP

`card_style` accepts an optional `windowIcon` independently of the card header's
`icon`. For example:

```json
{"runId":"card-id","runToken":"private-run-token","windowIcon":{"icon":"chart","color":"#74d4c8","background":"#101722"}}
```

Discover the 50 native names with `component_catalog.windowIcon`. Colors are
six-digit hex; omitted background is transparent. `resetWindowIcon: true`
restores the signal icon. The typed metadata also works in registration,
`style` publish operations, operator `view_configure`, HTTP
`PUT /api/agents/{id}/style`, and authored application `windowIcon` definitions.
`AgenticViewClient.configureWindowIcon(value)` accepts a descriptor or null.
No image paths, URLs, executables or scripts are accepted.

Supported standalone hosts apply changes while running, update their owned
shortcut/icon file, and retain the logical configuration for relaunch. This
keeps the card's existing AppUserModelID, process, profile and inspection state.
Pin the card manually. Windows may retain its cached icon on an already pinned
shortcut until the shell refreshes it or the operator repins it.
Direct `--card-id` windows with a custom profile still open and receive live
icons from the hub; use `--open-card` for owned durable icon files and shortcuts.

`card_window_icon_status` returns the configured descriptor, revision and at most
eight native window receipts. Match receipt revision and `state: "applied"` to
the current configuration; an empty/stale receipt does not establish application.
Receipts contain a process ID, per-launch window ID, logical configuration version
and observed time, never credentials or filesystem paths. Applying the same
configuration again requests a fresh revision. Older hosts need reopening to gain
the icon bridge. The viewer-authenticated report endpoint rejects stale revisions.
