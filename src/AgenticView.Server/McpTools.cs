using System.ComponentModel;
using System.Text.Json.Nodes;
using ModelContextProtocol;
using ModelContextProtocol.Server;

namespace AgenticView.Server;

[McpServerToolType]
public sealed class McpTools(Hub hub, ControlStore controls)
{
    private static JsonObject Invoke(Func<JsonObject> action)
    {
        try { return action(); }
        catch (HubError error) { throw new McpException(error.Message); }
    }
    [McpServerTool(Name = "agent_register", Idempotent = true, UseStructuredContent = true), Description("Register one run per execution. Keep a random registrationKey private for safe retries. Children supply parentId and parentToken. Returns runId and private runToken; heartbeat every 15 seconds and clean up your components when finished.")]
    public JsonObject Register(string requestId, string registrationKey, string agentId, string name, string role = "Agent", string context = "", string? parentId = null, string? parentToken = null,string? icon=null) => Invoke(() =>
    {
        var input = Json.Object(new { requestId, registrationKey, agentId, name, role, context });
        if (parentId is not null) input["parentId"] = parentId;
        if (parentToken is not null) input["parentToken"] = parentToken;
        if(icon is not null) input["icon"]=icon;
        return hub.Register(input);
    });

    [McpServerTool(Name = "agent_publish", Idempotent = true, UseStructuredContent = true), Description("Publish up to 256 atomic display operations. sequence increases exactly once per batch; retry identical content and sequence after uncertain delivery. Operations: upsert(component), append(componentId,items), remove(componentId), clear, context(text), status(active/completed/error). Call component_catalog for all typed schemas. Diffs, file trees and Markdown plans become subcards inside your agent card.")]
    public JsonObject Publish(string runId, string runToken, long sequence, JsonArray operations) => Invoke(() => hub.Publish(runId, runToken, new JsonObject { ["sequence"] = sequence, ["operations"] = operations.DeepClone() }));

    [McpServerTool(Name = "agent_heartbeat", Idempotent = true, UseStructuredContent = true), Description("Keep a run connected. Send every 15 seconds; an MCP transport connection alone does not establish liveness.")]
    public JsonObject Heartbeat(string runId, string runToken) => Invoke(() => hub.Heartbeat(runId, runToken));

    [McpServerTool(Name="card_style",Idempotent=true,UseStructuredContent=true),Description("Set the header icon of your card, including nested agent cards. Discover available names in component_catalog.cardStyle.icons. Use status to restore the default status dot. Examples: bot,terminal,code,database,server,search,shield,flask,gamepad,git-branch,bug,chart,rocket. This changes metadata only and preserves content, position and size.")]
    public JsonObject Style(string runId,string runToken,string icon)=>Invoke(()=>hub.SetCardStyle(runId,runToken,Json.Object(new{icon})));

    [McpServerTool(Name="session_publish",Idempotent=true,UseStructuredContent=true),Description("Report native components into an existing managed session card using its scoped sessionId/sessionToken environment values. Supply requestId and upsert/remove/append/context operations. Keep current plan first. Retry identical request content; server assigns sequence atomically. The session-console component is reserved. Never echo credentials.")]
    public JsonObject PublishSession(string sessionId,string sessionToken,string requestId,JsonArray operations)=>Invoke(()=>controls.PublishSession(sessionId,sessionToken,Json.Object(new{requestId,operations})));

    [McpServerTool(Name="session_child_register",Idempotent=true,UseStructuredContent=true),Description("Declare a child agent inside the current managed session card using its scoped sessionId/sessionToken. registration uses ordinary agent_register fields excluding parentId/parentToken; server binds the parent. Returns that child's private run token for its own reporting. Keep the child's current plan first.")]
    public JsonObject RegisterSessionChild(string sessionId,string sessionToken,JsonObject registration)=>Invoke(()=>controls.RegisterSessionChild(sessionId,sessionToken,registration));

    [McpServerTool(Name="ssh_connections",ReadOnly=true,Idempotent=true,UseStructuredContent=true),Description("List saved SSH machine configurations and reusable account references. Passwords are never returned. Credentials have no scheduled expiry; authentication rejection invalidates only that machine binding. Machine and account details are installation-private and must never be published in a repository.")]
    public JsonObject SshConnections()=>Invoke(controls.SshMachines);

    [McpServerTool(Name="ssh_machine_configure",Idempotent=false,UseStructuredContent=true),Description("Preconfigure an SSH machine for a connector: configuration {id,label,host,port?:22,connectorId,username?,password?,credentialLabel?,credentialId?}. Supply a new username/password OR reuse a saved credentialId from ssh_connections. Passwords are encrypted at rest and never returned. Explicitly authorized credentials only; do not publish them in card content or repository examples. A connector must allow the selected machine/remote agent profile before execution.")]
    public JsonObject ConfigureSsh(JsonObject configuration)=>Invoke(()=>controls.SaveSshMachine(configuration));

    [McpServerTool(Name="session_launcher_configure",Idempotent=true,UseStructuredContent=true),Description("Add or update a persistent button that creates a prompt/session card without executing it. Choose connectorId and its allowlisted handler (a local or SSH agent-session profile). Optional machineId selects a preconfigured SSH machine; remoteProfileId selects a connector-allowlisted remote launch recipe. Agent sessions start only after the operator enters a prompt and presses Start; optional confirmation is bound to this configuration version. Provider executable/arguments and working-directory authority remain in local connector or remote profiles. Use application_define/export to persist a portable launcher in the creating repository with logical bindings.")]
    public JsonObject ConfigureSessionLauncher(string runId,string runToken,string actionId,string label,string connectorId,string handler,string? machineId=null,string? remoteProfileId=null,string? confirmation=null)=>Invoke(()=>controls.ConfigureSessionLauncher(runId,runToken,actionId,label,connectorId,handler,machineId,remoteProfileId,confirmation));

    [McpServerTool(Name = "agent_archive", Idempotent = true, UseStructuredContent = true), Description("Retire your run, remove its live card, and retain its current bounded view in a compressed archive. Active child agents remain available independently.")]
    public JsonObject Archive(string runId, string runToken) => Invoke(() => { hub.AuthorizeArchive(runId, runToken); return hub.Archive(runId); });

    [McpServerTool(Name = "card_configure", Idempotent = false, UseStructuredContent = true), Description("Configure named actions for your card. Supply actions [{id,label,kind,target,handler?,confirmation?,fields?}]. target is agent for your prompt inbox or a connector ID whose local profile owns handler. kind: command,prompt,query,edit,history,logs,custom,session. Fields: key,label,type(text,multiline,number,select,toggle,json),required?,options?,min?,max?. Optional application {name,description?} makes this a permanent application card, exempt from automatic archiving. Keep credentials in local connector profiles; never in display fields. Discover native action-panel,log-stream,data-grid,session-launcher in component_catalog.")]
    public JsonObject Configure(string runId,string runToken,JsonArray actions,JsonObject? application=null) => Invoke(() => controls.Configure(runId,runToken,new JsonObject { ["actions"]=actions.DeepClone(),["application"]=application?.DeepClone() }));

    [McpServerTool(Name="application_define",Idempotent=true,UseStructuredContent=true),Description("Save an explicitly authored portable application manifest for your card and mark it permanent. Manifest: schemaVersion=1,id,version,name,permanent=true,bindings[{id,label}],actions,components,optional description/layout. Action targets are agent or logical binding IDs; no connector credentials, machine paths or runtime bindings belong in the manifest. This saves the template, not a snapshot of live telemetry. Export and write the JSON into the creating agent's own repository; review authored content for private information before publishing.")]
    public JsonObject DefineApplication(string runId,string runToken,JsonObject manifest)=>Invoke(()=>controls.DefineApplication(runId,runToken,manifest));

    [McpServerTool(Name="application_export",ReadOnly=true,Idempotent=true,UseStructuredContent=true),Description("Read your saved portable application definition for writing to a repository as an .agenticview.json file. Excludes live telemetry, invocation history, credentials and local binding values; authored templates still require source review before publication.")]
    public JsonObject ExportApplication(string runId,string runToken)=>Invoke(()=>{hub.VerifyRun(runId,runToken);return controls.ExportApplication(runId);});

    [McpServerTool(Name="application_import",Idempotent=true,UseStructuredContent=true),Description("Import a portable application manifest into a permanent card. Supply local bindings mapping each manifest binding ID to a connector ID, plus a unique requestId and private registrationKey (32+ characters) retained for exact retries. Returns private run credentials for subsequent management. Import applies components/actions but executes no command or edit; configured visible read monitors and trusted embeds may run when rendered. Retry identical content/proof; a new request creates a separate application instance.")]
    public JsonObject ImportApplication(JsonObject manifest,JsonObject bindings,string requestId,string registrationKey)=>Invoke(()=>controls.ImportApplication(Json.Object(new{manifest,bindings,requestId,registrationKey})));

    [McpServerTool(Name = "agent_actions_poll", Idempotent = false, UseStructuredContent = true), Description("Claim one operator action addressed to your agent inbox. Returns jobs; acknowledge using agent_action_complete and the private claimToken. Claimed jobs are never automatically replayed. Poll while active; transport connectivity alone does not deliver prompts.")]
    public JsonObject Poll(string runId,string runToken) => Invoke(() => new JsonObject { ["jobs"]=controls.Poll(runId,runToken,true) });

    [McpServerTool(Name = "agent_action_complete", Idempotent = true, UseStructuredContent = true), Description("Acknowledge an inbox job with state succeeded/failed/unknown and optional bounded JSON result/error. Retry identical completion after uncertain delivery; never execute the command again just to retry its acknowledgement.")]
    public JsonObject Complete(string runId,string runToken,string invocationId,string claimToken,string state,JsonObject? result=null,string? error=null) => Invoke(() => controls.Complete(runId,runToken,true,Json.Object(new{invocationId,claimToken,state,result,error})));

    [McpServerTool(Name = "component_catalog", ReadOnly = true, Idempotent = true, UseStructuredContent = true), Description("Discover all supported component kinds, input schemas and retention limits. Prefer built-in typed components for tasks, queries, commands, traces and visualizations. Reserve embeds for views the native catalog cannot express. Executable embeds are agent-authored code with external network access; their state bridge exposes no host credentials.")]
    public JsonObject Catalog() => new()
    {
        ["schemaVersion"] = 1,
        ["cardStyle"]=Json.Object(new{icons=CardStyles.Icons,defaultIcon="status",publication=new{op="style",icon="terminal"},description="Configure during agent_register, card_style, a style publish operation, or a portable application's icon field."}),
        ["rendering"] = Json.Object(new { preferNative = true, native = "Typed components use the built-in renderer and a Built-in badge.", custom = "embed runs agent-authored HTML/scripts in an isolated document, with a Custom view badge and distinct frame." }),
        ["schema"] = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "components.schema.json"))),
        ["applicationSchema"] = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "application-manifest.schema.json"))),
        ["limits"] = Json.Object(new { componentsPerRun = 64, liveRunBytes = 2_097_152, appendItems = 512, retainedRetryBatches = 256 }),
        ["cleanup"] = "Remove obsolete components or clear the view. Explicitly archive your run when finished. Automatic archiving is optional and disabled by default."
    };
}
