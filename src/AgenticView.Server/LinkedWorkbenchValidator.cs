using System.Text.Json;
using System.Text.Json.Nodes;
using static AgenticView.Server.ComponentValidator;
using static AgenticView.Server.ComponentConfiguration;

namespace AgenticView.Server;

/// <summary>Domain-neutral linked observations and bounded declarative local simulation metadata.</summary>
public static class LinkedWorkbenchValidator
{
    private const double LastInstant=8_640_000_000_000_000;
    public static void Validate(JsonObject data)
    {
        Keys(data,"title","entityLabel","searchLabel","searchPlaceholder","chartLabel","associationLabel","emptyLabel","entities","columns","rows","series","associations","pageSize","selectedId","style","simulations");
        foreach(var key in new[]{"title","searchLabel","chartLabel","associationLabel"})Text(data,key,160,false);
        Text(data,"entityLabel",100,false);Text(data,"searchPlaceholder",200,false);Text(data,"emptyLabel",200,false);
        var kinds=new HashSet<string>(StringComparer.Ordinal);
        foreach(var node in Array(data,"entities",32,1)){
            var entity=Object(node);Keys(entity,"id","label","plural","color","dash","marker");Unique(kinds,SafeId(entity,"id"),"Entity");Text(entity,"label",80);Text(entity,"plural",80,false);
            if(entity.ContainsKey("color"))Color(entity,"color");if(entity.ContainsKey("dash"))Choice(entity,"dash",["solid","dash","dot"]);if(entity.ContainsKey("marker"))Choice(entity,"marker",["circle","square"]);
        }
        var columns=new HashSet<string>(StringComparer.Ordinal);
        foreach(var node in Array(data,"columns",64)){
            var column=Object(node);Keys(column,"key","label","fields","format","decimals","smallDecimals","decimalsField","scale","suffix");Unique(columns,SafeId(column,"key"),"Column");Text(column,"label",100);
            if(column.ContainsKey("fields"))foreach(var field in Array(column,"fields",4,1))SafeId(new JsonObject{["id"]=field?.DeepClone()},"id");
            if(column.ContainsKey("format"))Choice(column,"format",["text","number","datetime","duration"]);
            foreach(var key in new[]{"decimals","smallDecimals"})if(column.ContainsKey(key))Number(column,key,0,10,true,true);
            if(column.ContainsKey("decimalsField"))SafeId(column,"decimalsField");if(column.ContainsKey("scale")&&Number(column,"scale",0)<=0)Fail("Scale must be positive.");Text(column,"suffix",40,false);
        }
        var rows=new Dictionary<string,JsonObject>(StringComparer.Ordinal);
        foreach(var node in Array(data,"rows",4000)){
            var row=Object(node);Keys(row,"id","parentId","kind","label","status","time","endTime","values");var id=SafeId(row,"id");if(!rows.TryAdd(id,row))Fail("Row identifiers must be unique.");
            if(row.ContainsKey("parentId"))SafeId(row,"parentId");if(!kinds.Contains(SafeId(row,"kind")))Fail("Row kind is not configured.");Text(row,"label",200,false);if(row.ContainsKey("status"))SafeId(row,"status");
            if(row.ContainsKey("time"))Instant(row,"time");if(row.ContainsKey("endTime")&&(!row.ContainsKey("time")||Instant(row,"endTime")<Instant(row,"time")))Fail("End time requires a start time and must not precede it.");Record(Object(row["values"]));
        }
        if(rows.Values.Count(row=>!row.ContainsKey("parentId"))>500)Fail("At most 500 roots.");
        var roots=new Dictionary<string,string>(StringComparer.Ordinal);
        foreach(var pair in rows){
            var row=pair.Value;var seen=new HashSet<string>(StringComparer.Ordinal);var depth=0;
            while(true){var id=SafeId(row,"id");if(!seen.Add(id)||++depth>16)Fail("Hierarchy must be acyclic and at most 16 nodes deep.");if(!row.ContainsKey("parentId")){roots[pair.Key]=id;break;}if(!rows.TryGetValue(SafeId(row,"parentId"),out var parent))Fail("Every parent must exist.");row=parent!;}
        }
        var seriesIds=new HashSet<string>(StringComparer.Ordinal);var pointCount=0;
        foreach(var node in Array(data,"series",500)){
            var series=Object(node);Keys(series,"rowId","tracks");var id=SafeId(series,"rowId");Unique(seriesIds,id,"Series");if(!rows.TryGetValue(id,out var root)||root.ContainsKey("parentId"))Fail("Series require a root row.");
            var tracks=new HashSet<string>(StringComparer.Ordinal);
            foreach(var trackNode in Array(series,"tracks",8,1)){
                var track=Object(trackNode);Keys(track,"id","label","color","decimals","points");Unique(tracks,SafeId(track,"id"),"Track");Text(track,"label",100);if(track.ContainsKey("color"))Color(track,"color");if(track.ContainsKey("decimals"))Number(track,"decimals",0,10,true,true);
                var points=Array(track,"points",256);pointCount+=points.Count;double previous=-1;
                foreach(var pointNode in points){var point=Object(pointNode);Keys(point,"time","value");var timestamp=Instant(point,"time");if(timestamp<=previous)Fail("Track times must strictly increase.");previous=timestamp;Number(point,"value");}
            }
        }
        if(pointCount>24000)Fail("At most 24000 total track points.");
        var edges=new HashSet<string>(StringComparer.Ordinal);
        foreach(var node in Array(data,"associations",4000)){
            var edge=Object(node);Keys(edge,"id","from","to","label");Unique(edges,SafeId(edge,"id"),"Association");Text(edge,"label",200,false);var from=SafeId(edge,"from");
            if(!rows.TryGetValue(from,out var source)||!source.ContainsKey("time"))Fail("Associations require timed rows.");
            if(edge.ContainsKey("to")){var to=SafeId(edge,"to");if(!rows.TryGetValue(to,out var target)||!target.ContainsKey("time")||roots[from]!=roots[to])Fail("Associations require timed rows in the same root.");}
        }
        if(data.ContainsKey("selectedId")&&!rows.ContainsKey(SafeId(data,"selectedId")))Fail("Selected row must exist.");
        if(data.ContainsKey("pageSize"))Number(data,"pageSize",1,25,true,true);if(data.ContainsKey("style"))Style(Object(data["style"]));
        if(data.ContainsKey("simulations")){
            var simulations=new HashSet<string>(StringComparer.Ordinal);
            foreach(var node in Array(data,"simulations",16)){
                var simulation=Object(node);Keys(simulation,"id","label","parentKind","kind","status","parentStatus","allowedStatuses","values","copyFields","parentValues","parentCopyFields","timeOffsetMs","message");Unique(simulations,SafeId(simulation,"id"),"Simulation");Text(simulation,"label",100);
                if(!kinds.Contains(SafeId(simulation,"parentKind"))||!kinds.Contains(SafeId(simulation,"kind")))Fail("Simulation kinds must be configured.");
                foreach(var key in new[]{"status","parentStatus"})if(simulation.ContainsKey(key))SafeId(simulation,key);
                if(simulation.ContainsKey("allowedStatuses"))foreach(var status in Array(simulation,"allowedStatuses",32))SafeId(new JsonObject{["id"]=status?.DeepClone()},"id");
                foreach(var key in new[]{"values","parentValues"})if(simulation.ContainsKey(key))Record(Object(simulation[key]));
                foreach(var key in new[]{"copyFields","parentCopyFields"})if(simulation.ContainsKey(key))Record(Object(simulation[key]),"id");
                if(simulation.ContainsKey("timeOffsetMs"))Number(simulation,"timeOffsetMs",0,86_400_000,true,true);Text(simulation,"message",300,false);
            }
        }
    }
    private static string SafeId(JsonObject value,string key){var id=Id(value,key);if(id.Any(char.IsControl))Fail("Use a safe identifier.");return id;}
    private static double Instant(JsonObject value,string key)=>Number(value,key,0,LastInstant,true,true);
    private static void Unique(HashSet<string> seen,string id,string label){if(!seen.Add(id))Fail(label+" identifiers must be unique.");}
    private static void Color(JsonObject value,string key){var color=Text(value,key,7,true,7);if(color[0]!='#'||color.Skip(1).Any(character=>!char.IsAsciiHexDigit(character)))Fail("Use a six-digit hex color.");}
    private static void Record(JsonObject value,string type="scalar"){
        if(value.Count>64)Fail("Use at most 64 own safe record keys.");foreach(var pair in value){SafeId(new JsonObject{["id"]=pair.Key},"id");var wrapped=new JsonObject{["value"]=pair.Value?.DeepClone()};if(type=="id")SafeId(wrapped,"value");else if(type=="color")Color(wrapped,"value");else if(pair.Value is not null){switch(pair.Value.GetValueKind()){case JsonValueKind.String:Text(wrapped,"value",2000);break;case JsonValueKind.Number:Number(wrapped,"value");break;case JsonValueKind.True:case JsonValueKind.False:break;default:Fail("Row values must be bounded scalars.");break;}}}
    }
    private static void Style(JsonObject style){
        Keys(style,"theme","accent","background","panel","text","muted","grid","kinds","statuses","tracks","rowHeight","fontSize");if(style.ContainsKey("theme"))Choice(style,"theme",["graphite","paper","terminal"]);
        foreach(var key in new[]{"accent","background","panel","text","muted","grid"})if(style.ContainsKey(key))Color(style,key);
        foreach(var key in new[]{"kinds","statuses","tracks"})if(style.ContainsKey(key))Record(Object(style[key]),"color");
        if(style.ContainsKey("rowHeight"))Number(style,"rowHeight",28,40,true,true);if(style.ContainsKey("fontSize"))Number(style,"fontSize",11,16,true,true);
    }
}
