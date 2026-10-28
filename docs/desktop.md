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
diagnostics. Repeated launches reuse a matching live host. `-Replace` stops only
the previously recorded process after matching its PID, creation time, command
line and private profile. The host also locks its profile to prevent concurrent
windows from sharing it. It never closes unrelated windows or processes.

For a bounded passive input diagnosis, set `AV_INPUT_TRACE=1` before launching.
For ten minutes the trusted main document may send up to 4,096 numeric gesture
records to the staged host's private stdout log. Records contain fixed event
labels and numeric coordinates, scroll offsets and routing values, never panel
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
