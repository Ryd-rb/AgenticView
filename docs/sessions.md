# Agent sessions

Create a reusable launcher once, then open prompt cards from the canvas. A draft
appears immediately and runs nothing. Enter a prompt and press **Start** to launch
the configured CLI. Session cards and their native provider IDs persist locally.

The hub routes work to a connector; it never executes a browser-supplied shell
command. A connector can run the CLI locally or through SSH on another machine.
Install the chosen provider CLI and sign in on the execution machine first.
AgenticView does not change its default model, hooks, permissions or sandbox.

## Configure everything from MCP

An agent with the installation ingestion key can prepare machines and launcher
cards before an operator needs them:

1. Call `ssh_connections` to discover saved machine and account **references**.
   No password is returned.
2. Call `ssh_machine_configure` with `{id,label,host,port,connectorId}` and either
   a privately supplied `username,password,credentialLabel`, or a `credentialId`
   from an earlier connection. Accounts can be reused across machines.
   Use `authentication: "agent"` without a password to keep existing SSH
   keys/agent/configuration; `username` is optional in that mode.
3. Register a normal card and call `session_launcher_configure` with its
   `runId,runToken,actionId,label,connectorId,handler`. For SSH, add `machineId`
   and optionally `remoteProfileId` to choose a connector-owned launch recipe.
4. Publish a current plan first. The helper adds a native `session-launcher`
   button and makes the launcher card permanent. `card_configure` also accepts
   `kind: "session"` actions directly.

Execution profiles remain explicit local allowlists. For example, a connector
handler can allow configured machines and expose named `codex` and `claude`
remote launch recipes. Agents select those recipes through MCP; they cannot
turn prompt text into executable shell source. The private connector profile
defines executable paths, arguments, working directories and permitted hosts.

Save a portable launcher as `.agenticview.json` using `application_define` and
`application_export`. Connector and machine IDs in portable definitions are
logical bindings supplied on import. Passwords, machine records, running session
IDs and native transcripts belong to the installation, never the repository.
See [the launcher example](../examples/applications/agent-sessions.agenticview.json).
It provides six buttons: local and SSH launches for Codex, Claude Code and OpenCode.
On import, bind `worker` to the session connector and `stage` to a saved SSH machine
assigned to that connector. The launcher retains the providers' configured defaults.

## Local and SSH profiles

Start a connector with its private configuration:

```sh
dotnet AgenticView.Server.dll --connector /private/connector.json
```

The [example configuration](../examples/connector/sessions.example.json) provides
local and SSH handlers. Local `provider` values are `codex`, `claude`, `opencode`
and `custom`. Native adapters use structured CLI output and explicit native
session IDs. A custom executable supplies fixed `arguments` / `resumeArguments`
and can emit JSON lines:

```json
{"type":"session","id":"provider-native-id"}
{"type":"output","format":"markdown","text":"## Progress\nReady"}
```

Supported formats are `text`, `markdown`, `html`, `json` and `code`. Other plain
stdout/stderr remains readable. `extraArguments`, `extraStartArguments` and
`extraResumeArguments` are fixed local profile settings. Prompt text travels over
stdin by default; use `promptTransport: "argument"` only for a CLI requiring it.
Interpreter adapters must use a fixed file, never eval flags.

For SSH, install the packaged .NET server and a private local agent-session profile
on the remote machine. The fixed `remoteCommand` invokes:

```sh
dotnet /opt/agenticview/AgenticView.Server.dll --session-stdio /private/codex.json
```

The example's `ssh-agent` handler allowlists three `remoteProfiles`. Each object
sets the matching `provider` and a fixed `command` selecting its remote private
profile. Create those remote profiles with `type: "agent-session"`, the matching
`provider`, its installed `executable` and an authorized `workingDirectory`, just
as for local handlers. Replace the example hosts and paths privately and retain
the connector's host allowlist. The example sets no model or permission overrides.

Set `remoteShell` to `posix` or `powershell` to match the SSH server. Each fixed
argument is quoted for that shell. Prompts, session IDs and scoped reporting
credentials travel through a bounded stdin envelope, never the SSH command line.
The remote bridge expects a heartbeat every five seconds and stops its owned
process on EOF or after twenty seconds without one. The remote machine must be
able to reach `reportingUrl`, or the connector's hub URL if no override is set.

SSH uses the machine's OpenSSH configuration, existing host-key trust and keys /
agent by default. Password mode uses a private same-user askpass pipe. It requires
the packaged executable apphost and an OpenSSH build supporting
[`SSH_ASKPASS_REQUIRE=force`](https://man.openbsd.org/ssh#SSH_ASKPASS_REQUIRE).
Windows support is documented in the [OpenSSH release notes](https://github.com/PowerShell/Win32-OpenSSH/releases/tag/V8.6.0.0p1-Beta).
No password is put in a process argument or environment variable.

## Saved machines and accounts

Open **Settings → SSH machines** to prepare or repair connections manually.
Passwords are encrypted with AES-GCM using a key derived from the installation's
private server secret. Protect that secret and the data directory together;
backups need both to restore access. Machine listings contain account references,
never decrypted passwords. Only the assigned authenticated connector can acquire
a password for execution.

There is no scheduled credential expiry. A confirmed SSH authentication rejection
invalidates the affected machine binding and pauses recovery until credentials
are replaced. Timeouts, unreachable hosts and agent failures do not invalidate
the saved login. A late rejection cannot invalidate newly replaced credentials.
Other machines sharing the previous account remain usable. **Forget account**
removes its saved password and invalidates all bindings that referenced it.

## Output and recovery

The console has follow-tail, pause-output, search, bounded pages and selectable
rich details. Pausing output polling does not pause the agent. Markdown is rendered
safely; executable HTML has a persistent **Custom view** label, opaque sandbox and
explicit interaction mode. Trusted-embed settings can disable HTML completely.

**Pause** interrupts the owned CLI process. **Resume** starts another turn using
its explicit native session ID when available. This is checkpointed provider
resume, not a promise that an arbitrary external operation can be frozen.
Completed sessions accept follow-up prompts in the same card.

Process failures attempt native resume. Failed resume or an optional silence
deadline produces a replacement session with the original prompt, retained
conversation/output and current component descriptions. The card stays in place;
the UI truthfully shows native versus handoff recovery and the current provider
ID. The handoff is bounded monitoring context, not a claim to restore a provider's
complete hidden state. Recovery instructions require inspecting previous effects
before retrying uncertain commands.

Automatic recovery allows two attempts per operator turn. Exhaustion requires
operator review; it never loops paid sessions indefinitely. Set local
`silenceTimeoutSeconds` to opt into silence detection (default off), and
`maxTurnSeconds` for a hard turn deadline. Legitimate agents may remain silent
while thinking or running tools.

The hub retains desired running/paused state across restart. Start the hub and
the configured connector again to recover desired running sessions. Remote SSH
sessions additionally require reachable SSH and hub endpoints. Cards reload even
when a worker is offline; their state explains what is waiting.

Bounds are independent of CLI output volume: eight concurrent sessions per worker,
4,000 retained output entries / 4 MiB per session, at most 200 entries / 256 KiB
per output page, and 2,000 entries / one million characters in the browser.
Overlong lines are truncated; overwritten output is reported. A private handoff
export includes a bounded recent transcript and component state. Provider-owned
history remains on the execution machine. These exports contain task data and
must not be added to a public repository.

Native contracts: [Codex noninteractive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
[Claude Code CLI](https://code.claude.com/docs/en/cli-reference),
[OpenCode CLI](https://opencode.ai/docs/cli/). CLI versions differ; validate the
installed executable and configure a fixed custom adapter when necessary.
