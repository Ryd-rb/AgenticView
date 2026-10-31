using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using static AgenticView.Server.ComponentValidator;

namespace AgenticView.Server;

/// <summary>Bounded declarative configuration. No expression evaluation or executable styling.</summary>
public static class ComponentConfiguration
{
    private static readonly string[] Editable = ["configuration.presentation","configuration.controls","configuration.rules","configuration.collection","configuration.label","configuration.description","configuration.tooltip","configuration.collapsed"];
    public static void Keys(JsonObject value, params string[] allowed) { if (value.Any(pair => !allowed.Contains(pair.Key, StringComparer.Ordinal))) Fail("Unknown configuration property."); }
    public static string Path(JsonObject value, string key)
    {
        var path = Text(value,key,160,true,1); var parts = path.Split('.');
        if (parts.Length > 8 || parts.Any(p => !Regex.IsMatch(p,"^[a-zA-Z0-9_-]+$",RegexOptions.CultureInvariant|RegexOptions.NonBacktracking) || p is "__proto__" or "prototype" or "constructor")) Fail("Invalid field path.");
        return path;
    }
    public static void Scalar(JsonNode? node)
    {
        if (node is null) return;
        if (node.GetValueKind() == JsonValueKind.String) Text(new JsonObject{["v"]=node.DeepClone()},"v",16384);
        else if (node.GetValueKind() == JsonValueKind.Number) Number(new JsonObject{["v"]=node.DeepClone()},"v");
        else if (node.GetValueKind() is not (JsonValueKind.True or JsonValueKind.False)) Fail("A configuration value must be scalar.");
    }
    private static void Record(JsonObject value) { foreach(var pair in value) { if(pair.Key.Length>100) Fail("Context field too long."); Scalar(pair.Value); } }
    public static void Condition(JsonObject condition)
    {
        Keys(condition,"all","any","none");
        foreach(var group in condition) foreach(var entry in Array(condition,group.Key,32)) {
            var atom=Object(entry); Keys(atom,"field","op","value","values"); Path(atom,"field");
            Choice(atom,"op",["eq","ne","in","not-in","gt","gte","lt","lte","contains","starts-with","empty","not-empty"]);
            var op=atom["op"]!.GetValue<string>();if(op is "in" or "not-in" && !atom.ContainsKey("values"))Fail("This operator requires values.");if(op is not ("in" or "not-in" or "empty" or "not-empty") && !atom.ContainsKey("value"))Fail("This operator requires value.");
            if(atom.ContainsKey("value")) Scalar(atom["value"]);
            if(atom.ContainsKey("values")) foreach(var item in Array(atom,"values",100)) Scalar(item);
        }
    }
    public static void Presentation(JsonObject value)
    {
        Keys(value,"surface","color","background","borderColor","emphasis","align","density","fontSize");
        if(value.ContainsKey("surface")) Choice(value,"surface",["default","plain"]);
        foreach(var key in new[]{"color","background","borderColor"}) if(value.ContainsKey(key) && !Regex.IsMatch(Text(value,key,7),"^#[0-9a-fA-F]{6}$",RegexOptions.CultureInvariant|RegexOptions.NonBacktracking)) Fail("Use a six-digit hex color.");
        if(value.ContainsKey("emphasis")) Choice(value,"emphasis",["normal","bold","muted"]);
        if(value.ContainsKey("align")) Choice(value,"align",["left","center","right"]);
        if(value.ContainsKey("density")) Choice(value,"density",["compact","comfortable","spacious"]);
        if(value.ContainsKey("fontSize")) Number(value,"fontSize",12,24,true,true);
    }
    private static void Effect(JsonObject effect)
    {
        Keys(effect,"label","tooltip","visible","presentation"); Text(effect,"label",160,false);Text(effect,"tooltip",2000,false);Boolean(effect,"visible");
        if(effect.ContainsKey("presentation")) Presentation(Object(effect["presentation"]));
    }
    public static void Validate(JsonObject configuration)
    {
        Keys(configuration,"controls","label","description","tooltip","visible","collapsed","presentation","context","rules","collection","manualFields");
        if(configuration.ContainsKey("controls")) ControlPresentation.Validate(Object(configuration["controls"]));
        Text(configuration,"label",160,false);Text(configuration,"description",2000,false);Text(configuration,"tooltip",2000,false);Boolean(configuration,"visible");Boolean(configuration,"collapsed");
        if(configuration.ContainsKey("presentation")) Presentation(Object(configuration["presentation"]));
        if(configuration.ContainsKey("context")) Record(Object(configuration["context"]));
        if(configuration.ContainsKey("rules")) foreach(var item in Array(configuration,"rules",64)) {var rule=Object(item);Keys(rule,"when","effect");Condition(Object(rule["when"]));Effect(Object(rule["effect"]));}
        if(configuration.ContainsKey("collection")) {
            var collection=Object(configuration["collection"]);Keys(collection,"field","filter","sortBy","descending","limit");Choice(collection,"field",["items","events","buckets","frames","entries","rows"]);
            if(collection.ContainsKey("filter")) Condition(Object(collection["filter"]));if(collection.ContainsKey("sortBy")) Path(collection,"sortBy");Boolean(collection,"descending");if(collection.ContainsKey("limit")) Number(collection,"limit",1,2000,true,true);
        }
        if(configuration.ContainsKey("manualFields")) foreach(var item in Array(configuration,"manualFields",64)) { var path=Path(new JsonObject{["field"]=item?.DeepClone()},"field");if(!path.StartsWith("data.",StringComparison.Ordinal)&&!Editable.Contains(path)) Fail("Manual fields cannot grant configuration authority."); }
    }
    public static void Constraint(JsonObject c)
    {
        Keys(c,"type","storage","required","nullable","min","max","minLength","maxLength","values","prefix","suffix");
        if(c.ContainsKey("type")) Choice(c,"type",["string","number","integer","boolean"]);if(c.ContainsKey("storage")) Choice(c,"storage",["native","string"]);Boolean(c,"required");Boolean(c,"nullable");
        foreach(var key in new[]{"min","max"}) if(c.ContainsKey(key)) Number(c,key);
        foreach(var key in new[]{"minLength","maxLength"}) if(c.ContainsKey(key)) Number(c,key,0,16384,true,true);
        if(c.ContainsKey("min")&&c.ContainsKey("max")&&Number(c,"min")>Number(c,"max")) Fail("Constraint minimum exceeds maximum.");
        if(c.ContainsKey("minLength")&&c.ContainsKey("maxLength")&&Number(c,"minLength")>Number(c,"maxLength")) Fail("Text minimum exceeds maximum.");
        Text(c,"prefix",1000,false);Text(c,"suffix",1000,false);if(c.ContainsKey("values")) foreach(var item in Array(c,"values",100)) Scalar(item);
    }
    public static void Grid(JsonObject data)
    {
        foreach(var key in new[]{"readAction","editAction","addAction","deleteAction","bulkAction","historyAction","evaluateAction","keyColumn","versionColumn"}) Id(data,key,false);
        if(data.ContainsKey("pageSize")) Number(data,"pageSize",1,200,true,true);
        var keys=new HashSet<string>(StringComparer.Ordinal);
        foreach(var node in Array(data,"columns",64,1)) { var c=Object(node); Keys(c,"key","label","editable","type","hidden","width","tooltip","constraints");if(!keys.Add(Id(c,"key"))) Fail("Grid column keys must be unique.");Text(c,"label",100);Boolean(c,"editable");Boolean(c,"hidden");if(c.ContainsKey("type")) Choice(c,"type",["text","number","toggle"]);if(c.ContainsKey("width")) Number(c,"width",60,800,true,true);Text(c,"tooltip",2000,false);if(c.ContainsKey("constraints")) Constraint(Object(c["constraints"])); }
        void Reference(string field) {if(!keys.Contains(field)) Fail("Grid configuration refers to an undeclared column.");}

        if(data.ContainsKey("keyColumns")) {var seen=new HashSet<string>();foreach(var node in Array(data,"keyColumns",32,1)) {var field=Id(new JsonObject{["key"]=node?.DeepClone()},"key");Reference(field);if(!seen.Add(field)) Fail("Key columns must be unique.");}}
        if(data.ContainsKey("rows")) foreach(var node in Array(data,"rows",2000)) foreach(var pair in Object(node)) {if(pair.Key.Length>100) Fail("Row field too long.");Scalar(pair.Value);}
        if(data.ContainsKey("rules")) foreach(var node in Array(data,"rules",128)) {
            var rule=Object(node);Keys(rule,"id","when","column","constraints","presentation","tooltip");Id(rule,"id");Condition(Object(rule["when"]));
            if(rule.ContainsKey("column")) Reference(Id(rule,"column"));if(rule.ContainsKey("constraints")) Constraint(Object(rule["constraints"]));if(rule.ContainsKey("presentation")) Presentation(Object(rule["presentation"]));Text(rule,"tooltip",2000,false);
        }
        if(data.ContainsKey("features")) { var features=Object(data["features"]);Keys(features,"hideColumns","filter","sort","add","edit","delete","bulk","history","evaluate","explain");foreach(var pair in features) Boolean(features,pair.Key); }
        if(data.ContainsKey("precedence")) {
            var p=Object(data["precedence"]);Keys(p,"groupBy","mandatory","dimensions","emptyValues","context","label");
            foreach(var name in new[]{"groupBy","mandatory","dimensions"}) if(p.ContainsKey(name)||name!="mandatory") {var seen=new HashSet<string>();foreach(var node in Array(p,name,32,name=="mandatory"?0:1)) {var field=Id(new JsonObject{["field"]=node?.DeepClone()},"field");Reference(field);if(name!="mandatory"&&!seen.Add(field)) Fail("Precedence fields must be unique.");}}
            if(p.ContainsKey("emptyValues")) foreach(var node in Array(p,"emptyValues",32)) Scalar(node);if(p.ContainsKey("context")) Record(Object(p["context"]));Text(p,"label",160,false);
        }
    }
    public static JsonObject Apply(JsonObject component, JsonObject input)
    {
        Budget(input); Keys(input,"expected","changes");
        if(!JsonNode.DeepEquals(component,input["expected"])) throw new HubError(409,"Component changed. Reopen settings before saving.");
        var allowed=component["configuration"]?["manualFields"] as JsonArray ?? throw new HubError(403,"Manual settings are disabled for this component.");
        var changes=Object(input["changes"]);if(changes.Count is <1 or >64) Fail("Supply 1 to 64 setting changes.");
        var candidate=(JsonObject)component.DeepClone();
        foreach(var change in changes) {
            var path=Path(new JsonObject{["field"]=change.Key},"field");
            if(!allowed.Any(node=>node?.GetValue<string>()==path)) throw new HubError(403,"This field is not enabled for manual settings.");
            var parts=path.Split('.');var target=candidate;
            foreach(var part in parts[..^1]) { if(!target.ContainsKey(part)) target[part]=new JsonObject();target=Object(target[part]); }
            target[parts[^1]]=change.Value?.DeepClone();
        }
        ComponentValidator.Validate(candidate);return candidate;
    }
}
