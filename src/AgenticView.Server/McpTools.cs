using System.ComponentModel;
using System.Text.Json.Nodes;
using ModelContextProtocol;
using ModelContextProtocol.Server;

namespace AgenticView.Server;

[McpServerToolType]
public sealed class McpTools(Hub hub)
{
    private static JsonObject Invoke(Func<JsonObject> action)
    {
        try { return action(); }
        catch (HubError error) { throw new McpException(error.Message); }
    }
    [McpServerTool(Name = "agent_register", Idempotent = true, UseStructuredContent = true), Description("Register one run per execution. Keep a random registrationKey private for safe retries. Children supply parentId and parentToken. Returns runId and private runToken; heartbeat every 15 seconds and clean up your components when finished.")]
    public JsonObject Register(string requestId, string registrationKey, string agentId, string name, string role = "Agent", string context = "", string? parentId = null, string? parentToken = null) => Invoke(() =>
    {
        var input = Json.Object(new { requestId, registrationKey, agentId, name, role, context });
        if (parentId is not null) input["parentId"] = parentId;
        if (parentToken is not null) input["parentToken"] = parentToken;
        return hub.Register(input);
    });

    [McpServerTool(Name = "agent_publish", Idempotent = true, UseStructuredContent = true), Description("Publish up to 256 atomic display operations. sequence increases exactly once per batch; retry identical content and sequence after uncertain delivery. Operations: upsert(component), append(componentId,items), remove(componentId), clear, context(text), status(active/completed/error). Call component_catalog for all typed schemas. Diffs, file trees and Markdown plans become subcards inside your agent card.")]
    public JsonObject Publish(string runId, string runToken, long sequence, JsonArray operations) => Invoke(() => hub.Publish(runId, runToken, new JsonObject { ["sequence"] = sequence, ["operations"] = operations.DeepClone() }));

    [McpServerTool(Name = "agent_heartbeat", Idempotent = true, UseStructuredContent = true), Description("Keep a run connected. Send every 15 seconds; an MCP transport connection alone does not establish liveness.")]
    public JsonObject Heartbeat(string runId, string runToken) => Invoke(() => hub.Heartbeat(runId, runToken));

    [McpServerTool(Name = "agent_archive", Idempotent = true, UseStructuredContent = true), Description("Retire your run, remove its live card, and retain its current bounded view in a compressed archive. Active child agents remain available independently.")]
    public JsonObject Archive(string runId, string runToken) => Invoke(() => { hub.AuthorizeArchive(runId, runToken); return hub.Archive(runId); });

    [McpServerTool(Name = "component_catalog", ReadOnly = true, Idempotent = true, UseStructuredContent = true), Description("Discover all supported component kinds, input schemas and retention limits. Executable embeds are trusted code with external network access; their state bridge exposes no host credentials.")]
    public JsonObject Catalog() => new()
    {
        ["schemaVersion"] = 1,
        ["schema"] = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "components.schema.json"))),
        ["limits"] = Json.Object(new { componentsPerRun = 64, liveRunBytes = 2_097_152, appendItems = 512, retainedRetryBatches = 256 }),
        ["cleanup"] = "Remove obsolete components or clear the view. Explicitly archive your run when finished. Automatic archiving is optional and disabled by default."
    };
}
