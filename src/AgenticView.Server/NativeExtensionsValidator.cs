using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using static AgenticView.Server.ComponentValidator;

namespace AgenticView.Server;

/// <summary>Bounded typed chart and native view payloads. No executable styling or expressions.</summary>
public static class NativeExtensionsValidator
{
    private static readonly string[] Types = ["line", "area", "bar", "scatter"];
    private static readonly string[] Tones = ["neutral", "info", "success", "warning", "error"];
    private static void Keys(JsonObject value, params string[] allowed)
    {
        foreach (var pair in value) if (!allowed.Contains(pair.Key, StringComparer.Ordinal)) Fail($"Unsupported native option: {pair.Key}.");
    }
    private static void Color(JsonObject value)
    {
        if (value.ContainsKey("color") && !Regex.IsMatch(Text(value, "color", 7), "^#[0-9a-fA-F]{6}$", RegexOptions.CultureInvariant | RegexOptions.NonBacktracking)) Fail("Use a six digit hex color.");
    }
    private static void OptionalChoice(JsonObject value, string key, string[] choices) { if (value.ContainsKey(key)) Choice(value, key, choices); }
    private static void Format(JsonNode? node)
    {
        var value = Object(node, "format"); Keys(value, "style", "decimals", "prefix", "suffix"); OptionalChoice(value, "style", ["number", "percent", "compact"]);
        Number(value, "decimals", 0, 8, false, true); Text(value, "prefix", 24, false); Text(value, "suffix", 24, false);
    }
    private static void Axis(JsonNode? node)
    {
        var value = Object(node, "axis"); Keys(value, "label", "min", "max", "includeZero", "visible", "grid", "ticks", "format");
        Text(value, "label", 100, false); Number(value, "min", required: false); Number(value, "max", required: false);
        if (value.ContainsKey("min") && value.ContainsKey("max") && Number(value, "max") <= Number(value, "min")) Fail("Axis max must exceed min.");
        foreach (var key in new[] { "includeZero", "visible", "grid" }) Boolean(value, key);
        Number(value, "ticks", 2, 10, false, true); if (value.ContainsKey("format")) Format(value["format"]);
    }
    private static void Condition(JsonNode? node)
    {
        var value = Object(node, "condition"); Keys(value, "operator", "value", "upper"); Choice(value, "operator", ["lt", "lte", "gt", "gte", "eq", "between"]);
        var low = Number(value, "value"); Number(value, "upper", required: false);
        if (Text(value, "operator", 80) == "between" && (!value.ContainsKey("upper") || Number(value, "upper") < low)) Fail("Between conditions require an upper bound at least equal to value.");
    }
    private static void Features(JsonObject parent, params string[] names)
    {
        if (!parent.ContainsKey("features")) return;
        var features = Object(parent["features"], "features"); Keys(features, names); foreach (var name in names) Boolean(features, name);
    }
    public static void ValidateChart(JsonObject data)
    {
        Keys(data, "type", "series", "xLabel", "yLabel", "options"); Choice(data, "type", Types, "line"); Text(data, "xLabel", 100, false); Text(data, "yLabel", 100, false);
        var ids = new HashSet<string>(StringComparer.Ordinal); var numeric = true;
        foreach (var node in Array(data, "series", 12))
        {
            var series = Object(node); Keys(series, "id", "name", "type", "color", "dash", "width", "marker", "hidden", "points"); Text(series, "name", 100);
            if (series.ContainsKey("id") && !ids.Add(Id(series, "id"))) Fail("Series IDs must be unique.");
            OptionalChoice(series, "type", Types); Color(series); OptionalChoice(series, "dash", ["solid", "dashed", "dotted"]); Number(series, "width", 1, 6, false);
            OptionalChoice(series, "marker", ["none", "circle", "square", "diamond"]); Boolean(series, "hidden");
            foreach (var pointNode in Array(series, "points", 2048))
            {
                var point = Object(pointNode); Keys(point, "x", "y", "label"); Number(point, "y"); Text(point, "label", 160, false);
                if (point["x"]?.GetValueKind() == JsonValueKind.String) { Text(point, "x", 100); numeric = false; } else Number(point, "x");
            }
        }
        if (!data.ContainsKey("options")) return;
        var options = Object(data["options"], "options"); Keys(options, "xAxis", "yAxis", "legend", "markers", "tooltips", "labels", "labelWhen", "tooltipWhen", "annotations", "features");
        foreach (var key in new[] { "xAxis", "yAxis" }) if (options.ContainsKey(key)) Axis(options[key]);
        foreach (var key in new[] { "legend", "markers", "tooltips", "labels" }) Boolean(options, key);
        foreach (var key in new[] { "labelWhen", "tooltipWhen" }) if (options.ContainsKey(key)) Condition(options[key]);
        Features(options, "seriesToggle", "dataTable");
        if (!numeric && options["xAxis"] is JsonObject xAxis && (xAxis.ContainsKey("min") || xAxis.ContainsKey("max"))) Fail("X domains require numeric x values.");
        if (!options.ContainsKey("annotations")) return;
        var annotations = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in Array(options, "annotations", 32))
        {
            var annotation = Object(node); Keys(annotation, "id", "axis", "value", "end", "label", "color", "dash");
            if (!annotations.Add(Id(annotation, "id"))) Fail("Annotation IDs must be unique."); Choice(annotation, "axis", ["x", "y"]);
            var start = Number(annotation, "value"); if (annotation.ContainsKey("end") && Number(annotation, "end") < start) Fail("Band end must not precede value.");
            Text(annotation, "label", 160, false); Color(annotation); OptionalChoice(annotation, "dash", ["solid", "dashed", "dotted"]);
            if (!numeric && Text(annotation, "axis", 80) == "x") Fail("X annotations require numeric x values.");
        }
    }
    public static void ValidateAdditional(string kind, JsonObject data)
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        switch (kind)
        {
            case "stepper":
                Keys(data, "items", "selectedId", "orientation", "features"); OptionalChoice(data, "orientation", ["vertical", "horizontal"]); Features(data, "select"); Id(data, "selectedId", false);
                foreach (var node in Array(data, "items", 100))
                {
                    var item = Object(node); Keys(item, "id", "label", "state", "detail"); if (!ids.Add(Id(item, "id"))) Fail("Step IDs must be unique.");
                    Text(item, "label", 200); Choice(item, "state", ["pending", "active", "completed", "blocked", "skipped"]); Text(item, "detail", 8192, false);
                }
                if (data.ContainsKey("selectedId") && !ids.Contains(Id(data, "selectedId"))) Fail("Selected step must exist.");
                break;
            case "bullet":
                Keys(data, "value", "min", "max", "target", "unit", "label", "format", "ranges"); Number(data, "value");
                if (!data.ContainsKey("min")) data["min"] = 0; if (!data.ContainsKey("max")) data["max"] = 100;
                var min = Number(data, "min"); var max = Number(data, "max"); if (max <= min) Fail("Bullet max must exceed min.");
                Number(data, "target", required: false); Text(data, "unit", 80, false); Text(data, "label", 200, false); if (data.ContainsKey("format")) Format(data["format"]);
                if (data.ContainsKey("ranges")) foreach (var node in Array(data, "ranges", 12))
                {
                    var range = Object(node); Keys(range, "id", "end", "label", "tone"); if (!ids.Add(Id(range, "id"))) Fail("Range IDs must be unique.");
                    var end = Number(range, "end"); if (end <= min || end > max) Fail("Range ends must increase within the declared domain."); min = end;
                    Text(range, "label", 160); OptionalChoice(range, "tone", Tones);
                }
                break;
            case "accordion":
                Keys(data, "sections", "multiple", "features"); Boolean(data, "multiple"); Features(data, "expand"); var opens = 0;
                foreach (var node in Array(data, "sections", 100))
                {
                    var section = Object(node); Keys(section, "id", "title", "text", "tone", "open"); if (!ids.Add(Id(section, "id"))) Fail("Section IDs must be unique.");
                    Text(section, "title", 200); Text(section, "text", 16384); OptionalChoice(section, "tone", Tones); if (Boolean(section, "open")) opens++;
                }
                if (data.ContainsKey("multiple") && !Boolean(data, "multiple") && opens > 1) Fail("Single expansion accordions allow at most one initially open section.");
                break;
            default: Fail("Unsupported additional native kind."); break;
        }
    }
}
