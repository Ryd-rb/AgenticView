using System.Text.Json.Nodes;

namespace AgenticView.Server;

/// <summary>Explicit operator capability. Ingestion, run and session keys confer no cross-card access.</summary>
public sealed class OperatorView(Hub hub, ControlStore controls, RuntimeConfig config)
{
    private void Authorize(string token)
    {
        if (!Authentication.Equal(token, config.Secrets.ViewerToken)) throw new HubError(403, "An explicitly supplied installation operator (viewer) key is required.");
    }
    public JsonObject Read(string token, string resource, string? cardId, int offset, int limit)
    {
        Authorize(token);
        if (offset < 0 || limit is < 1 or > 100) throw new HubError(400, "Use a page size from 1 to 100.");
        return resource switch
        {
            "cards" => hub.Cards(offset, limit),
            "card" => hub.GetRun(cardId ?? "") ?? throw new HubError(404, "Card unavailable."),
            "settings" => hub.Settings,
            "archives" => new JsonObject { ["cards"] = hub.Archives(offset, limit) },
            "archive" => hub.ReadArchive(cardId ?? ""),
            "controls" => controls.Configuration(cardId ?? ""),
            "session" => controls.SessionView(hub.GetRun(cardId ?? "")?["managedSessionId"]?.GetValue<string>() ?? throw new HubError(404, "Card has no managed session.")),
            _ => throw new HubError(400, "Unknown view resource.")
        };
    }
    public JsonObject Configure(string token, string operation, JsonObject input)
    {
        Authorize(token); ComponentValidator.Budget(input);
        if (operation == "settings") return hub.SetSettings(input);
        if(operation=="shortcuts") {var settings=hub.Settings;settings["cardShortcuts"]=input["shortcuts"]?.DeepClone()??throw new HubError(400,"shortcuts is required.");return hub.SetSettings(settings);}
        if (operation == "arrange") return hub.PackLayout(input);
        if (operation == "orphan") return hub.Orphan(input);
        var id = ComponentValidator.Id(input, "cardId");
        if (operation == "restore") return hub.Restore(id);
        if (operation == "archive") return hub.Archive(id);
        var runToken = hub.OwnedToken(id);
        return operation switch
        {
            "layout" => hub.SetLayout(id, ComponentValidator.Object(input["layout"])),
            "style" => hub.SetCardStyle(id, runToken, ComponentValidator.Object(input["style"])),
            "name" => hub.Rename(id, ComponentValidator.Text(input, "name", 160, true, 1)),
            "publish" => hub.Publish(id, runToken, ComponentValidator.Object(input["batch"])),
            "controls" => controls.Configure(id, runToken, ComponentValidator.Object(input["configuration"])),
            "session" => ControlSession(id, input),
            _ => throw new HubError(400, "Unknown view configuration operation.")
        };
    }
    private JsonObject ControlSession(string cardId, JsonObject input)
    {
        var sessionId = ComponentValidator.Id(input, "sessionId");
        if (Json.String(controls.SessionView(sessionId), "runId") != cardId) throw new HubError(409, "Session does not belong to the selected card.");
        return controls.ControlSession(sessionId, ComponentValidator.Object(input["control"]));
    }
}
