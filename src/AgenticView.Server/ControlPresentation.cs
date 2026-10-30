using System.Text.Json.Nodes;
using static AgenticView.Server.ComponentValidator;

namespace AgenticView.Server;

public static class ControlPresentation
{
    private static readonly HashSet<string> Ids = ["configure", "header", "footer", "title", "role", "context", "agentId", "times", "status", "fit", "lock", "collapse", "archive", "resize", "navigation", "zoomIn", "zoomOut", "resetView", "deactivate", "scale", "caption", "filter", "refresh", "add", "edit", "delete", "history", "evaluate", "bulk", "columns", "pagination", "legend", "dataTable", "stepSelect", "expand", "save", "cancel"];
    private static readonly HashSet<string> Properties = ["visible", "label", "tooltip", "appearance", "variant", "placement", "mode", "initiallyOpen"];
    public static string[] Catalog => Ids.Order(StringComparer.Ordinal).ToArray();
    public static void Validate(JsonObject map)
    {
        if (map.Count > Ids.Count) Fail("Control map exceeds its bounded catalog.");
        foreach (var pair in map)
        {
            if (!Ids.Contains(pair.Key)) Fail("Unsupported control identifier.");
            var value = Object(pair.Value, "control presentation");
            if (value.Any(property => !Properties.Contains(property.Key))) Fail("Unknown control presentation property.");
            Boolean(value, "visible"); Boolean(value, "initiallyOpen"); Text(value, "label", 160, false); Text(value, "tooltip", 2000, false);
            if (value.ContainsKey("appearance")) Choice(value, "appearance", ["icon", "text", "both"]);
            if (value.ContainsKey("variant")) Choice(value, "variant", ["quiet", "primary"]);
            if (value.ContainsKey("placement")) Choice(value, "placement", ["header", "footer", "top-left", "top-right", "bottom-left", "bottom-right"]);
            if (value.ContainsKey("mode")) Choice(value, "mode", ["disclosure", "panel"]);
        }
    }
}
