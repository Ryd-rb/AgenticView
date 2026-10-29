# Deferred subscription connection controls

The ordinary six-launcher template has no gateway requirement. The optional
`agent-sessions-with-subscription.agenticview.json` template adds **Connect Codex
subscription** and **Check connection status** to the same permanent application.
It binds `setup` to a connector on the machine that owns the separately installed
gateway. Importing the template starts neither login nor inference.

`examples/connector/subscription-profile.example.json` describes that Windows
connector, using PowerShell 7.2 or newer.
Copy `subscription-connection.ps1` beside its private profile and replace the
example installation key, random registration proof and fixed gateway directory.
Keep the profile, gateway and credentials outside source control. A separate
setup connector can be used without changing the existing session connector,
hub, tunnels or desktop window.

The wrapper expects an already prepared private gateway directory containing
`login-bounded.py`, `Start-Gateway.ps1`, `start-gateway.py`, `config.yaml`,
`private.json`, and its isolated Python environment at `venv/Scripts/python.exe`.
These installation-owned helpers must use a dedicated OAuth cache under
`auth/auth.json`, preserve the normal Codex login, prohibit API-billing fallback,
bind the gateway to loopback and make no automatic inference checks. The example
does not install LiteLLM, select a subscription entitlement or change provider
profiles. Validate those separately for the installed provider versions.

Only an explicit **Connect** action starts a fresh separate device login or starts
the configured gateway using saved authentication. **Check connection status**
reads local metadata only. It does not refresh tokens, open a browser, start a
process or call a model. A pending login returns the current device URL/code and
expiry in the action result; check status again while completing it. Stale codes
are omitted, and old private login logs are retained under distinct names.

The login worker has a 620-second outer limit around the bounded private helper.
Launch intent, PID, executable, creation time and deadline are retained. An
uncertain launch blocks a fresh login until inspected. The wrapper never kills
an existing gateway or another listener. Worker and native output go to private
files, while action results exclude tokens, raw authentication logs and machine
paths. Authentication and gateway startup remain separate from any optional,
explicitly authorized end-to-end model check.

The status fixtures validate redaction and absence of login side effects with
synthetic files. They do not establish a real device-code login, live subscription
access, native process-receipt behavior or provider inference compatibility.
