using System.Text.Json.Nodes;
using AgenticView.Server;

internal static class NativeExtensionsContracts
{
    public static void Run()
    {
        ComponentConfigurationReviewContracts.Run();
        JsonObject Parse(string text) => JsonNode.Parse(text)!.AsObject();
        void Reject(Action action) { try { action(); } catch (HubError error) when (error.Status == 400) { return; } throw new Exception("Invalid native extension payload was accepted."); }
        var legacy = Parse("""{"series":[{"name":"Legacy","points":[{"x":0,"y":1}]}]}""");
        NativeExtensionsValidator.ValidateChart(legacy);
        if (legacy["type"]!.GetValue<string>() != "line") throw new Exception("Legacy chart default changed.");
        NativeExtensionsValidator.ValidateChart(Parse("""{"series":[{"id":"latency","name":"Latency","color":"#abcdef","marker":"diamond","points":[{"x":1,"y":3}]}],"options":{"xAxis":{"min":0,"max":2},"yAxis":{"format":{"style":"compact","decimals":1}},"annotations":[{"id":"budget","axis":"y","value":2,"end":4}],"labelWhen":{"operator":"between","value":1,"upper":5},"features":{"seriesToggle":true,"dataTable":false}}}"""));
        foreach (var invalid in new[] {
            """{"series":[],"options":{"xAxis":{"min":2,"max":1}}}""",
            """{"series":[],"options":{"labelWhen":{"operator":"between","value":1}}}""",
            """{"series":[],"options":{"annotations":[{"id":"a","axis":"y","value":1,"color":"url(x)"}]}}""",
            """{"series":[],"options":{"features":{"execute":true}}}""",
            """{"series":[{"id":"a","name":"One","points":[]},{"id":"a","name":"Two","points":[]}]}""",
            """{"series":[{"name":"Category","points":[{"x":"first","y":1}]}],"options":{"xAxis":{"min":0}}}""",
            """{"series":[{"name":"Category","points":[{"x":"first","y":1}]}],"options":{"annotations":[{"id":"a","axis":"x","value":0}]}}""",
        }) Reject(() => NativeExtensionsValidator.ValidateChart(Parse(invalid)));
        var bullet = Parse("""{"value":45,"target":60,"ranges":[{"id":"ok","end":70,"label":"Expected","tone":"success"}]}""");
        NativeExtensionsValidator.ValidateAdditional("bullet", bullet);
        if (bullet["min"]!.GetValue<int>() != 0 || bullet["max"]!.GetValue<int>() != 100) throw new Exception("Bullet defaults changed.");
        NativeExtensionsValidator.ValidateAdditional("stepper", Parse("""{"selectedId":"inspect","items":[{"id":"inspect","label":"Inspect","state":"active"}],"features":{"select":true}}"""));
        NativeExtensionsValidator.ValidateAdditional("accordion", Parse("""{"sections":[{"id":"summary","title":"Summary","text":"Literal <script>text</script>"}],"features":{"expand":false}}"""));
        Reject(() => NativeExtensionsValidator.ValidateAdditional("stepper", Parse("""{"selectedId":"missing","items":[]}""")));
        Reject(() => NativeExtensionsValidator.ValidateAdditional("bullet", Parse("""{"value":1,"ranges":[{"id":"a","end":30,"label":"A"},{"id":"b","end":20,"label":"B"}]}""")));
        Reject(() => NativeExtensionsValidator.ValidateAdditional("accordion", Parse("""{"multiple":false,"sections":[{"id":"a","title":"A","text":"","open":true},{"id":"b","title":"B","text":"","open":true}]}""")));
        Reject(() => NativeExtensionsValidator.ValidateAdditional("accordion", Parse("""{"sections":[{"id":"a","title":"A","text":"","html":"unexpected"}]}""")));
    }
}
