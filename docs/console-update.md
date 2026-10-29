# Updating an existing console

Use the original console checkout and its existing preview receipt. Do not start
a second hub, recreate connector profiles or rerun an installation bootstrap.
Update source with a normal fast-forward merge, retaining any local changes.
The deployment helpers require PowerShell 7.2 or newer on Windows.

Prepare a runtime ZIP with the published server files at its root, including
`wwwroot`, and the published desktop files under `desktop/`. Use validated
Windows x64 outputs and obtain the ZIP's SHA256 from the build machine through
the trusted delivery channel. Keep credentials, databases and logs out of it.

From the existing checkout, stage a local package first:

```powershell
pwsh -NoProfile -File scripts/pull-console-update.ps1 `
  -RuntimeZip C:/Delivery/runtime.zip -Sha256 '<trusted SHA256>'
```

Alternatively, the console can pull through an already configured outbound SSH
alias. This needs no inbound SSH service on the console:

```powershell
pwsh -NoProfile -File scripts/pull-console-update.ps1 `
  -SourceHost build-host -RemotePath C:/Delivery/runtime.zip `
  -Sha256 '<trusted SHA256>'
```

Staging verifies the hash, bounds extraction, rejects links and unsafe paths,
and refuses private state in runtime inputs. It changes no running service.
Its receipt contains the explicit command for applying that staged copy.

Before applying, pause or finish managed sessions and wait for connector leases
to expire. Keep other operators and automation from invoking new actions during
the update. The helper checks both the bounded HTTP view and persisted session
records, including archived cards and recent WAL transactions. These checks do
not constitute an atomic maintenance lock against concurrent action requests.

Apply requires an existing Python 3.10+ interpreter with SQLite JSON support for
the fixed, read-only inventory helper. Python is an optional deployment tool;
the server remains C# and does not depend on it. No installation or download is
performed. Use the staged receipt's command with that interpreter, for example:

```powershell
pwsh -NoProfile -File scripts/pull-console-update.ps1 `
  -RuntimeZip C:/Delivery/runtime.zip -Sha256 '<trusted SHA256>' `
  -Python C:/Tools/Python/python.exe -Apply
```

Apply verifies the recorded hub process, listener, data directory and viewer key.
It retains existing generated outputs in an owned backup, installs the new
outputs, and asks `start-preview.ps1` to replace that owned hub. The starter
waits for its old process to exit before copying its latest private data into a
new stage. If the original desktop is running with its recorded private profile,
it restarts through `start-desktop.ps1` using that same profile. An absent desktop
receipt does not create a new window. Connectors, tunnels, provider settings and
custom launch shortcuts are retained.

Receipts remain under `.task/runtime-updates/`; preview data and process receipts
remain under `.task/preview/` and `.task/preview-session.json`. A failed Apply
retains a blocked guard. Inspect the exact phase, current process and latest data
before attempting repair. Do not automatically replay an uncertain launch or
restore an older database after the new hub could have accepted traffic. Backups
are retained for deliberate recovery, not an automatic database rollback.

`start-preview.ps1` records intent before creating a process and records its
identity before waiting for health. It stops a failed new process only when that
exact process still matches. Uncertain identity prevents another automatic
startup. Synthetic contracts cover these paths; they do not substitute for an
update of the actual installation or manual desktop review.

## Adding optional connection controls

For an existing permanent launcher, attach
`examples/applications/codex-subscription-setup.agenticview.json` beneath it.
Replacing the original launcher's action configuration would change its global
configuration version and can invalidate retained session actions.

Keep three small input files outside tracked source: a connection file with
`url` and `ingestionKey`, the existing parent state with `runId` and `runToken`,
and a binding map such as `{"setup":"subscription-setup-connector"}`. The
connector must already be configured on the gateway's owning machine as described
in [subscription setup](subscription-setup.md).

```powershell
pwsh -NoProfile -File scripts/attach-application.ps1 `
  -ConnectionFile C:/Private/hub-connection.json `
  -ParentStateFile C:/Private/launcher-state.json `
  -Manifest examples/applications/codex-subscription-setup.agenticview.json `
  -BindingsFile C:/Private/setup-bindings.json `
  -StateFile C:/Private/subscription-child-state.json
```

The private state contains registration proof and the child run token. Preserve
it for exact retry and keep it out of source control. The helper binds it to the
hub origin, parent proof, manifest and bindings, captures each bounded input once,
and saves registration/configuration/publish intent before submission. It
configures only the child, and invokes no action. A completed retry checks that
child with a heartbeat instead of reconfiguring it. Changed inputs require
inspection of the existing attachment.

Importing or attaching these controls starts neither OAuth nor inference. An
explicit Connect action is required. Opening the main application should also
remain independent of optional gateway login; review any private shortcut that
starts a gateway merely because an authentication metadata file exists.
