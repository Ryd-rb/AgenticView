using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using static AgenticView.Server.ComponentValidator;

namespace AgenticView.Server;

public static class GridValidation
{
    private static JsonNode? Field(JsonObject source,string path)
    {
        if(source.ContainsKey(path))return source[path];
        JsonNode? current=source;foreach(var part in path.Split('.')) {if(current is not JsonObject obj || !obj.TryGetPropertyValue(part,out current))return null;}return current;
    }
    private static bool Equal(JsonNode? left,JsonNode? right) => JsonNode.DeepEquals(left,right);
    private static bool Empty(JsonNode? value) => value is null || value.GetValueKind()==JsonValueKind.String&&value.GetValue<string>()=="";
    private static bool MatchAtom(JsonObject atom,JsonObject row)
    {
        var field=atom["field"]!.GetValue<string>();var value=Field(row,field);var expected=atom["value"];var op=atom["op"]!.GetValue<string>();
        // Missing and null differ for equality, matching the declarative client evaluator.
        var exists=row.ContainsKey(field)||Exists(row,field);
        var same=exists&&Equal(value,expected);
        return op switch {
            "eq"=>same, "ne"=>!same, "empty"=>Empty(value), "not-empty"=>!Empty(value),
            "in"=>exists&&atom["values"] is JsonArray list&&list.Any(item=>Equal(value,item)),
            "not-in"=>!exists||atom["values"] is not JsonArray values||!values.Any(item=>Equal(value,item)),
            "contains"=>value?.GetValueKind()==JsonValueKind.String&&expected?.GetValueKind()==JsonValueKind.String&&value.GetValue<string>().Contains(expected.GetValue<string>(),StringComparison.Ordinal),
            "starts-with"=>value?.GetValueKind()==JsonValueKind.String&&expected?.GetValueKind()==JsonValueKind.String&&value.GetValue<string>().StartsWith(expected.GetValue<string>(),StringComparison.Ordinal),
            _=>Compare(value,expected,op)
        };
    }
    private static bool Exists(JsonObject source,string path) {JsonNode? current=source;foreach(var part in path.Split('.')) {if(current is not JsonObject obj||!obj.TryGetPropertyValue(part,out current))return false;}return true;}
    private static bool Compare(JsonNode? left,JsonNode? right,string op)
    {
        if(left?.GetValueKind()!=JsonValueKind.Number||right?.GetValueKind()!=JsonValueKind.Number)return false;
        var a=left.GetValue<double>();var b=right.GetValue<double>();return op switch{"gt"=>a>b,"gte"=>a>=b,"lt"=>a<b,"lte"=>a<=b,_=>false};
    }
    private static bool Matches(JsonObject condition,JsonObject row) =>
        (condition["all"] is not JsonArray all||all.All(node=>MatchAtom(Object(node),row))) &&
        (condition["any"] is not JsonArray any||any.Any(node=>MatchAtom(Object(node),row))) &&
        (condition["none"] is not JsonArray none||!none.Any(node=>MatchAtom(Object(node),row)));
    public static void Row(JsonObject data,JsonObject row)
    {
        foreach(var pair in row) ComponentConfiguration.Scalar(pair.Value);
        foreach(var node in (JsonArray)data["columns"]!) {
            var column=Object(node);var key=column["key"]!.GetValue<string>();var c=column["constraints"] is JsonObject constraints?(JsonObject)constraints.DeepClone():new JsonObject();
            if(data["rules"] is JsonArray rules)foreach(var rule in rules.OfType<JsonObject>())if((rule["column"] is null||rule["column"]!.GetValue<string>()==key)&&Matches(Object(rule["when"]),row)&&rule["constraints"] is JsonObject extra)foreach(var pair in extra)c[pair.Key]=pair.Value?.DeepClone();
            var value=row[key];var label=column["label"]!.GetValue<string>();
            void Invalid(string reason)=>Fail(label+": "+reason);
            if(value is null || value.GetValueKind()==JsonValueKind.String&&value.GetValue<string>()=="") {
                if(Boolean(c,"required")&&!(row.ContainsKey(key)&&value is null&&Boolean(c,"nullable")))Invalid("a value is required");
                if(value is null&&row.ContainsKey(key)&&c["nullable"]?.GetValue<bool>()==false)Invalid("null is not allowed");
                if(value is null)continue;
            }
            var type=c["type"]?.GetValue<string>()??(column["type"]?.GetValue<string>() switch{"number"=>"number","toggle"=>"boolean",_=>null});
            if(c["storage"]?.GetValue<string>()=="string") {
                if(value!.GetValueKind()!=JsonValueKind.String)Invalid("expected string storage");
                var text=value!.GetValue<string>();
                if(type=="boolean"&&text is "true" or "false")value=JsonValue.Create(text=="true");
                else if(type is "number" or "integer"&&text.Trim().Length>0&&double.TryParse(text,NumberStyles.Float,CultureInfo.InvariantCulture,out var number)&&double.IsFinite(number))value=JsonValue.Create(number);
            }
            var kind=value!.GetValueKind();
            if(type=="string"&&kind!=JsonValueKind.String || type=="boolean"&&kind is not(JsonValueKind.True or JsonValueKind.False) || type is "number" or "integer"&&kind!=JsonValueKind.Number)Invalid("expected "+type);
            if(kind==JsonValueKind.Number) {var number=value.GetValue<double>();if(!double.IsFinite(number)||type=="integer"&&number!=Math.Truncate(number)||c["min"] is not null&&number<c["min"]!.GetValue<double>()||c["max"] is not null&&number>c["max"]!.GetValue<double>())Invalid("outside allowed numeric range");}
            if(kind==JsonValueKind.String) {var text=value.GetValue<string>();if(c["minLength"] is not null&&text.Length<c["minLength"]!.GetValue<int>()||c["maxLength"] is not null&&text.Length>c["maxLength"]!.GetValue<int>()||c["prefix"] is not null&&!text.StartsWith(c["prefix"]!.GetValue<string>(),StringComparison.Ordinal)||c["suffix"] is not null&&!text.EndsWith(c["suffix"]!.GetValue<string>(),StringComparison.Ordinal))Invalid("does not meet text constraints");}
            if(c["values"] is JsonArray allowed&&!allowed.Any(item=>Equal(item,value)))Invalid("not an allowed value");
        }
    }
    public static void Action(JsonObject view,string actionId,JsonObject input)
    {
        var grids=(view["components"] as JsonObject)?.Select(pair=>pair.Value).OfType<JsonObject>().Where(c=>c["kind"]?.GetValue<string>()=="data-grid"&&c["data"] is JsonObject d&&new[]{"addAction","editAction","bulkAction","deleteAction","historyAction","evaluateAction"}.Any(key=>d[key]?.GetValue<string>()==actionId)).ToArray()??[];
        if(grids.Length==0)return;
        var componentId=input["componentId"] is null?null:Text(input,"componentId",100);
        var grid=componentId is null&&grids.Length==1?grids[0]:grids.FirstOrDefault(g=>g["id"]?.GetValue<string>()==componentId)??throw new HubError(400,"Specify the grid componentId for this action.");
        var data=Object(grid["data"]);
        foreach(var featureName in new[]{"history","evaluate"}) if(data[featureName+"Action"]?.GetValue<string>()==actionId) {if(data["features"]?[featureName]?.GetValue<bool>()==false)throw new HubError(403,"Grid feature is disabled.");return;}
        var operation=Text(input,"operation",20);
        var binding=operation switch{"add"=>"addAction","update"=>"editAction","bulk"=>"bulkAction","delete"=>"deleteAction",_=>throw new HubError(400,"Unsupported grid operation.")};
        if(data[binding]?.GetValue<string>()!=actionId)Fail("Grid action does not match this operation.");
        var feature=operation=="update"?"edit":operation;
        if(data["features"]?[feature]?.GetValue<bool>()==false)throw new HubError(403,"Grid feature is disabled.");
        if(operation=="delete")return;
        if(input["rows"] is JsonArray rows) {if(rows.Count is <1 or >2000)Fail("Supply bounded full rows.");foreach(var row in rows)Row(data,Object(row));}
        if(input["row"] is JsonObject single)Row(data,single);
        if(input["rows"] is not JsonArray&&input["row"] is not JsonObject)Fail("Grid changes require full rows.");
    }
}
