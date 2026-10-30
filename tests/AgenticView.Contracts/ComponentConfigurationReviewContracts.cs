using System.Text.Json.Nodes;
using AgenticView.Server;

internal static class ComponentConfigurationReviewContracts
{
    public static void Run()
    {
        JsonObject Parse(string text) => JsonNode.Parse(text)!.AsObject();
        void Reject(Action action, int status) { try { action(); } catch (HubError error) when (error.Status == status) { return; } throw new Exception($"Expected configuration rejection {status}."); }
        var current = Parse("""{"id":"metric","kind":"metric","title":"Metric","data":{"value":1,"unit":"ms"},"configuration":{"manualFields":["data.unit","configuration.label"]}}""");
        ComponentValidator.Validate(current);
        JsonObject Request(JsonObject changes) => new() { ["expected"] = current.DeepClone(), ["changes"] = changes };
        var updated = ComponentConfiguration.Apply(current, Request(Parse("""{"data.unit":"seconds","configuration.label":"Duration"}""")));
        if (updated["data"]!["unit"]!.GetValue<string>() != "seconds" || current["data"]!["unit"]!.GetValue<string>() != "ms") throw new Exception("Manual changes did not preserve the original component.");
        Reject(() => ComponentConfiguration.Apply(current, Request(Parse("""{"configuration.manualFields":["data.value"]}"""))), 403);
        Reject(() => ComponentConfiguration.Apply(current, Request(Parse("""{"data":{"value":100}}"""))), 403);
        Reject(() => ComponentConfiguration.Apply(current, Request(Parse("""{"data.unit":{"script":"x"}}"""))), 400);
        Reject(() => ComponentConfiguration.Apply(current, Request(Parse("""{"data.__proto__.polluted":true}"""))), 400);
        var stale = Request(Parse("""{"data.unit":"seconds"}""")); stale["expected"]!["title"] = "Stale";
        Reject(() => ComponentConfiguration.Apply(current, stale), 409);
        var grid = Parse("""{"columns":[{"key":"count","label":"Count","constraints":{"type":"integer","storage":"string","required":true,"min":0,"max":10}},{"key":"flag","label":"Flag","constraints":{"type":"boolean","storage":"string","required":true}}]}""");
        ComponentConfiguration.Grid(grid);
        var row = Parse("""{"count":"2","flag":"false"}"""); var before = row.ToJsonString(); GridValidation.Row(grid, row);
        if (before != row.ToJsonString()) throw new Exception("Validation changed string storage.");
        foreach (var invalid in new[] { """{"count":2,"flag":"false"}""", """{"count":"2x","flag":"false"}""", """{"count":"2.5","flag":"false"}""", """{"count":"2","flag":"FALSE"}""" }) Reject(() => GridValidation.Row(grid, Parse(invalid)), 400);
    }
}
