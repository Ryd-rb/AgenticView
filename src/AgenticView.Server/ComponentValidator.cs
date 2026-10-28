using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Globalization;

namespace AgenticView.Server;

public static class ComponentValidator
{
    private static readonly HashSet<string> Reserved = ["__proto__", "prototype", "constructor"];
    private static readonly Regex Identifier = new("^[a-zA-Z0-9_.:-]+$", RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);
    public static void Fail(string message) => throw new HubError(400, message);
    public static string Text(JsonObject value, string key, int max, bool required = true, int min = 0)
    {
        if (!value.TryGetPropertyValue(key, out var node)) { if (required) Fail($"{key} is required."); return ""; }
        if (node is not JsonValue scalar || !scalar.TryGetValue<string>(out var text) || text.Length > max || text.Length < min) Fail($"{key} must be text of length {min}–{max}.");
        return node!.GetValue<string>();
    }
    public static string Id(JsonObject value, string key, bool required = true)
    {
        var id = Text(value, key, 100, required, value.ContainsKey(key) ? 1 : 0);
        if (id.Length != 0 && (!Identifier.IsMatch(id) || Reserved.Contains(id))) Fail($"{key} is not a permitted identifier.");
        return id;
    }
    public static double Number(JsonObject value, string key, double min = double.MinValue, double max = double.MaxValue, bool required = true, bool integer = false)
    {
        if (!value.TryGetPropertyValue(key, out var node)) { if (required) Fail($"{key} is required."); return 0; }
        if (node?.GetValueKind() != JsonValueKind.Number || !double.TryParse(node.ToJsonString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var number) || !double.IsFinite(number) || number < min || number > max || integer && number != Math.Truncate(number)) Fail($"{key} must be a finite number within {min}–{max}.");
        return double.Parse(node!.ToJsonString(), CultureInfo.InvariantCulture);
    }
    public static bool Boolean(JsonObject value, string key, bool fallback = false)
    {
        if (!value.TryGetPropertyValue(key, out var node)) return fallback;
        if (node is not JsonValue scalar || !scalar.TryGetValue<bool>(out var result)) Fail($"{key} must be boolean.");
        return node!.GetValue<bool>();
    }
    public static JsonObject Object(JsonNode? node, string label = "value") => node as JsonObject ?? throw new HubError(400, $"{label} must be an object.");
    public static JsonArray Array(JsonObject value, string key, int max, int min = 0)
    {
        if (value[key] is not JsonArray items || items.Count < min || items.Count > max) Fail($"{key} must be an array with {min}–{max} entries.");
        return (JsonArray)value[key]!;
    }
    public static void Choice(JsonObject value, string key, string[] choices, string? fallback = null)
    {
        if (!value.ContainsKey(key) && fallback is not null) { value[key] = fallback; return; }
        if (!choices.Contains(Text(value, key, 80), StringComparer.Ordinal)) Fail($"{key} is unsupported.");
    }
    private static void Scalar(JsonNode? node, int max = 16384)
    {
        if (node is null) return;
        if (node is not JsonValue scalar) Fail("A table or metric scalar cannot contain objects or arrays.");
        var kind = node!.GetValueKind();
        if (kind == JsonValueKind.String) { if (node.GetValue<string>().Length > max) Fail("Scalar text is too long."); }
        else if (kind == JsonValueKind.Number) { if (!double.TryParse(node.ToJsonString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var number) || !double.IsFinite(number)) Fail("Numbers must be finite."); }
        else if (kind is not (JsonValueKind.True or JsonValueKind.False or JsonValueKind.Null)) Fail("Unsupported scalar value.");
    }
    private static void HttpUrl(JsonObject value, string key)
    {
        var url = Text(value, key, 2048);
        if (url.Any(char.IsWhiteSpace) || !Regex.IsMatch(url, @"^https?://", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant) || Regex.IsMatch(url, @"^https?://[^/?#]*@", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant) || !Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https") || uri.Host.Length == 0 || uri.UserInfo.Length != 0) Fail("URLs must use HTTP(S) without user information.");
    }
    public static void Budget(JsonNode? root)
    {
        var stack = new Stack<(JsonNode?, int)>(); stack.Push((root, 0)); var count = 0;
        while (stack.TryPop(out var current))
        {
            if (++count > 100000 || current.Item2 > 48) Fail("JSON exceeds the depth or element budget.");
            if (current.Item1 is JsonObject obj) foreach (var pair in obj) { if (Reserved.Contains(pair.Key)) Fail("Reserved JSON property."); stack.Push((pair.Value, current.Item2 + 1)); }
            if (current.Item1 is JsonArray arr) foreach (var item in arr) stack.Push((item, current.Item2 + 1));
            if (current.Item1 is JsonValue val && val.GetValueKind() == JsonValueKind.Number && (!double.TryParse(val.ToJsonString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var number) || !double.IsFinite(number))) Fail("JSON numbers must be finite.");
        }
    }
    public static void Validate(JsonObject component, bool checkBudget = true)
    {
        if (checkBudget) Budget(component); Id(component, "id"); Text(component, "title", 160);
        var kind = Text(component, "kind", 32); var data = Object(component["data"], "data");
        switch (kind)
        {
            case "action-panel":
                foreach (var item in Array(data,"actionIds",64,1)) Id(new JsonObject { ["id"]=item?.DeepClone() },"id");
                break;
            case "log-stream":
                Id(data,"actionId"); if(data.ContainsKey("pollMs")) Number(data,"pollMs",500,60000,true,true); if(data.ContainsKey("maxRows")) Number(data,"maxRows",20,2000,true,true);
                break;
            case "data-grid":
                Id(data,"readAction",false); Id(data,"editAction",false); Id(data,"addAction",false); Id(data,"deleteAction",false); Id(data,"bulkAction",false); Id(data,"historyAction",false); Id(data,"keyColumn",false); Id(data,"versionColumn",false); if(data.ContainsKey("pageSize")) Number(data,"pageSize",1,200,true,true);
                if(data.ContainsKey("rows")) foreach(var item in Array(data,"rows",2000)) foreach(var pair in Object(item)) { if(pair.Key.Length>100) Fail("Row field names are limited to 100 characters."); Scalar(pair.Value); }
                foreach(var node in Array(data,"columns",64,1)) { var column=Object(node); Id(column,"key"); Text(column,"label",100); Boolean(column,"editable"); if(column.ContainsKey("type")) Choice(column,"type",["text","number","toggle"]); }
                break;
            case "metric":
                if (!data.ContainsKey("value")) Fail("metric.value is required."); Scalar(data["value"]); Text(data, "unit", 80, false); Text(data, "change", 160, false);
                if (data.ContainsKey("tone")) Choice(data, "tone", ["neutral", "info", "success", "warning", "error"]);
                if (data.ContainsKey("history")) foreach (var item in Array(data, "history", 512)) { var wrapper = new JsonObject { ["n"] = item?.DeepClone() }; Number(wrapper, "n"); }
                break;
            case "chart":
                Choice(data, "type", ["line", "area", "bar", "scatter"], "line"); Text(data, "xLabel", 100, false); Text(data, "yLabel", 100, false);
                foreach (var item in Array(data, "series", 12))
                {
                    var series = Object(item); Text(series, "name", 100);
                    foreach (var p in Array(series, "points", 2048)) { var point = Object(p); Number(point, "y"); if (point["x"]?.GetValueKind() == JsonValueKind.String) Text(point, "x", 100); else Number(point, "x"); }
                }
                break;
            case "table":
                foreach (var c in Array(data, "columns", 64, 1)) { var column = Object(c); Id(column, "key"); Text(column, "label", 100); }
                foreach (var r in Array(data, "rows", 2000)) foreach (var cell in Object(r)) { if (cell.Key.Length > 100) Fail("Column key too long."); Scalar(cell.Value); }
                Number(data, "totalRows", 0, double.MaxValue, false, true); Id(data,"sourceAction",false); if(data.ContainsKey("pageSize")) Number(data,"pageSize",1,200,true,true); break;
            case "markdown": Text(data, "text", 131072); break;
            case "code": Text(data, "code", 131072); Text(data, "language", 40, false); break;
            case "diff": Text(data, "before", 131072); Text(data, "after", 131072); Text(data, "language", 40, false); break;
            case "logs":
                foreach (var n in Array(data, "entries", 2000)) { var entry = Object(n); Text(entry, "time", 80, false); Choice(entry, "level", ["debug", "info", "warn", "error"], "info"); Text(entry, "message", 16384); Text(entry, "source", 160, false); } break;
            case "timeline":
                foreach (var n in Array(data, "events", 1000)) { var e = Object(n); Text(e, "time", 80, false); Text(e, "title", 200); Text(e, "detail", 8192, false); if (e.ContainsKey("tone")) Choice(e, "tone", ["neutral", "info", "success", "warning", "error"]); } break;
            case "progress":
                Number(data, "value", 0); if (!data.ContainsKey("max")) data["max"] = 100; if (Number(data, "max", 0) <= 0) Fail("max must be positive."); Text(data, "label", 200, false); break;
            case "keyvalue":
                foreach (var n in Array(data, "items", 200)) { var item = Object(n); Text(item, "key", 160); if (!item.ContainsKey("value")) Fail("value is required."); Scalar(item["value"]); } break;
            case "json": if (!data.ContainsKey("value")) Fail("json.value is required."); break;
            case "tree":
                var parents = new Dictionary<string, string?>();
                foreach (var n in Array(data, "nodes", 1000)) { var node = Object(n); var id = Id(node, "id"); Text(node, "label", 200); Text(node, "detail", 1000, false); var parent = Id(node, "parentId", false); if (!parents.TryAdd(id, parent.Length == 0 ? null : parent)) Fail("Tree node IDs must be unique."); }
                foreach (var id in parents.Keys) { var seen = new HashSet<string>(); string? current = id; while (current is not null) { if (!seen.Add(current)) Fail("Tree must not contain cycles."); if (!parents.TryGetValue(current, out current)) Fail("Tree parent is missing."); } } break;
            case "status": Text(data, "label", 200); Choice(data, "state", ["active", "success", "warning", "error", "idle"]); Text(data, "detail", 2000, false); break;
            case "embed": Text(data, "html", 524288); if (!data.ContainsKey("height")) data["height"] = 300; Number(data, "height", 120, 1200, true, true); break;
            case "stat-grid":
                foreach (var n in Array(data, "items", 24)) { var item = Object(n); Text(item, "label", 160); if (!item.ContainsKey("value")) Fail("value is required."); Scalar(item["value"]); Text(item, "unit", 80, false); Text(item, "change", 160, false); if (item.ContainsKey("tone")) Choice(item, "tone", ["neutral", "info", "success", "warning", "error"]); } break;
            case "checklist":
            {
                var ids = new HashSet<string>(StringComparer.Ordinal);
                foreach (var n in Array(data, "items", 200)) { var item = Object(n); if (!ids.Add(Id(item, "id"))) Fail("Checklist IDs must be unique."); Text(item, "label", 500); Choice(item, "status", ["pending", "active", "completed", "blocked"]); Text(item, "detail", 2000, false); } break;
            }
            case "bar-list":
                Text(data, "unit", 80, false); foreach (var n in Array(data, "items", 100)) { var item = Object(n); Text(item, "label", 200); Number(item, "value", 0); if (item.ContainsKey("tone")) Choice(item, "tone", ["neutral", "info", "success", "warning", "error"]); } break;
            case "histogram":
                Text(data, "unit", 80, false); foreach (var n in Array(data, "buckets", 100)) { var bucket = Object(n); Text(bucket, "label", 100); Number(bucket, "count", 0, 9_007_199_254_740_991d, true, true); } break;
            case "heatmap":
            {
                Text(data, "unit", 80, false); var columns = Array(data, "columns", 32, 1); var rows = Array(data, "rows", 64, 1);
                foreach (var label in columns.Concat(rows)) Text(new JsonObject { ["label"] = label?.DeepClone() }, "label", 100);
                var coordinates = new HashSet<(int Row, int Column)>();
                foreach (var n in Array(data, "cells", 2048)) { var cell = Object(n); var row = (int)Number(cell, "row", 0, 63, true, true); var column = (int)Number(cell, "column", 0, 31, true, true); Number(cell, "value"); if (row >= rows.Count || column >= columns.Count || !coordinates.Add((row, column))) Fail("Heatmap coordinates must be unique and fit the declared dimensions."); } break;
            }
            case "gauge":
                Number(data, "value"); if (!data.ContainsKey("min")) data["min"] = 0; if (!data.ContainsKey("max")) data["max"] = 100; var minimum = Number(data, "min"); if (Number(data, "max") <= minimum) Fail("Gauge max must exceed min."); Text(data, "unit", 80, false); Text(data, "label", 200, false); break;
            case "query":
                Text(data, "query", 131072); if (!data.ContainsKey("language")) data["language"] = "sql"; Text(data, "language", 40); Text(data, "source", 160, false); Choice(data, "state", ["running", "success", "error"], "running"); Text(data, "error", 8192, false); Number(data, "durationMs", 0, double.MaxValue, false); Number(data, "totalRows", 0, 9_007_199_254_740_991d, false, true);
                if (!data.ContainsKey("columns")) data["columns"] = new JsonArray(); if (!data.ContainsKey("rows")) data["rows"] = new JsonArray();
                foreach (var n in Array(data, "columns", 64)) { var column = Object(n); Id(column, "key"); Text(column, "label", 100); }
                var queryRows = Array(data, "rows", 2000); if (queryRows.Count > 0 && ((JsonArray)data["columns"]!).Count == 0) Fail("Query rows require columns.");
                foreach (var row in queryRows) foreach (var cell in Object(row)) { if (cell.Key.Length > 100) Fail("Column key too long."); Scalar(cell.Value); } break;
            case "command":
                Text(data, "command", 131072); Text(data, "shell", 40, false); Text(data, "directory", 1000, false); Text(data, "output", 131072, false); Number(data, "exitCode", int.MinValue, int.MaxValue, false, true); Number(data, "durationMs", 0, double.MaxValue, false); break;
            case "trace":
            {
                var spanParents = new Dictionary<string, string?>(StringComparer.Ordinal);
                foreach (var n in Array(data, "spans", 500)) { var span = Object(n); var id = Id(span, "id"); var parent = Id(span, "parentId", false); if (!spanParents.TryAdd(id, parent.Length == 0 ? null : parent)) Fail("Trace span IDs must be unique."); Text(span, "name", 200); Number(span, "startMs", 0); Number(span, "durationMs", 0); Choice(span, "status", ["active", "success", "error"], "success"); }
                foreach (var id in spanParents.Keys) { var seen = new HashSet<string>(StringComparer.Ordinal); string? current = id; while (current is not null) { if (!seen.Add(current) || !spanParents.TryGetValue(current, out current)) Fail("Trace parents must exist and be acyclic."); } } break;
            }
            case "alert": Choice(data, "tone", ["neutral", "info", "success", "warning", "error"], "info"); Text(data, "message", 8192); Text(data, "detail", 131072, false); break;
            case "links":
                foreach (var n in Array(data, "items", 100)) { var item = Object(n); Text(item, "label", 200); Text(item, "description", 1000, false); var url = Text(item, "url", 2048); if (url.Any(char.IsWhiteSpace) || !Regex.IsMatch(url, @"^https?://", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant) || Regex.IsMatch(url, @"^https?://[^/?#]*@", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant) || !Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https") || uri.Host.Length == 0 || uri.UserInfo.Length != 0) Fail("Links must use HTTP(S) without user information."); } break;
            case "comparison":
                foreach (var n in Array(data, "items", 100)) { var item = Object(n); Text(item, "label", 200); if (!item.ContainsKey("before") || !item.ContainsKey("after")) Fail("Comparison before and after are required."); Scalar(item["before"]); Scalar(item["after"]); } break;
            case "service-map":
            {
                var nodeIds = new HashSet<string>(StringComparer.Ordinal);
                foreach (var n in Array(data, "nodes", 100)) { var node = Object(n); if (!nodeIds.Add(Id(node, "id"))) Fail("Service node IDs must be unique."); Text(node, "label", 200); Text(node, "detail", 1000, false); if (node.ContainsKey("state")) Choice(node, "state", ["active", "success", "warning", "error", "idle"]); }
                foreach (var n in Array(data, "edges", 200)) { var edge = Object(n); if (!nodeIds.Contains(Id(edge, "from")) || !nodeIds.Contains(Id(edge, "to"))) Fail("Service edge endpoints must exist."); Text(edge, "label", 160, false); } break;
            }
            case "http":
                Choice(data, "method", ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]); HttpUrl(data, "url"); Number(data, "statusCode", 100, 599, false, true); Number(data, "durationMs", 0, double.MaxValue, false); Text(data, "requestBody", 131072, false); Text(data, "responseBody", 131072, false); break;
            case "stacktrace":
                Text(data, "exception", 200, false); Text(data, "message", 8192, false); foreach (var n in Array(data, "frames", 1000)) { var frame = Object(n); Text(frame, "method", 1000); Text(frame, "file", 1000, false); Text(frame, "module", 200, false); Number(frame, "line", 1, 9_007_199_254_740_991d, false, true); } break;
            case "test-results":
            {
                var testIds = new HashSet<string>(StringComparer.Ordinal);
                foreach (var n in Array(data, "items", 1000)) { var item = Object(n); if (!testIds.Add(Id(item, "id"))) Fail("Test IDs must be unique."); Text(item, "label", 500); Choice(item, "state", ["passed", "failed", "skipped", "running", "pending"]); Number(item, "durationMs", 0, double.MaxValue, false); Text(item, "detail", 8192, false); } break;
            }
            case "gantt":
            {
                var itemIds = new HashSet<string>(StringComparer.Ordinal);
                foreach (var n in Array(data, "items", 200)) { var item = Object(n); if (!itemIds.Add(Id(item, "id"))) Fail("Timeline IDs must be unique."); Text(item, "label", 200); var start = Number(item, "start", 0, 8_640_000_000_000_000d); if (item.ContainsKey("end") && Number(item, "end", 0, 8_640_000_000_000_000d) < start) Fail("Timeline end must not precede start."); Text(item, "group", 160, false); if (item.ContainsKey("tone")) Choice(item, "tone", ["neutral", "info", "success", "warning", "error"]); } break;
            }
            case "breakdown":
                Text(data, "unit", 80, false); foreach (var n in Array(data, "items", 100)) { var item = Object(n); Text(item, "label", 200); Number(item, "value", 0); if (item.ContainsKey("tone")) Choice(item, "tone", ["neutral", "info", "success", "warning", "error"]); } break;
            default: Fail("Unsupported component kind."); break;
        }
    }
}
