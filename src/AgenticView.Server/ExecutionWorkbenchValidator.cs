using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using static AgenticView.Server.ComponentValidator;
using static AgenticView.Server.ComponentConfiguration;

namespace AgenticView.Server;

/// <summary>Bounded typed execution observations. This component grants no execution authority.</summary>
public static class ExecutionWorkbenchValidator
{
    private const double LastInstant = 8_640_000_000_000_000;
    private static readonly string[] Statuses = ["created","running","paused","completed","error","pending","working","partially-filled","filled","cancelled","rejected","open","closed","failed"];
    public static void Validate(JsonObject data)
    {
        Keys(data,"rows","series","pageSize","selectedId","demo","style");
        if(data.ContainsKey("style")) Style(Object(data["style"]));
        var rows = new Dictionary<string,JsonObject>(StringComparer.Ordinal);
        var strategies = 0;
        foreach (var node in Array(data,"rows",4000))
        {
            var row=Object(node);
            Keys(row,"id","parentId","kind","strategyId","ticker","side","orderType","status","quantity","bid","ask","start","end","filledQuantity","filledPrice","error");
            var id=Id(row,"id"); if(!rows.TryAdd(id,row)) Fail("Row identifiers must be unique.");
            if(row.ContainsKey("parentId")) Id(row,"parentId"); Id(row,"strategyId");
            Choice(row,"kind",["strategy","order","trade"]); Choice(row,"side",["buy","sell"]); Choice(row,"orderType",["limit","stop-loss"]); Choice(row,"status",Statuses);
            if(!Regex.IsMatch(Text(row,"ticker",7,true,7),"^[A-Z]{3}/[A-Z]{3}$",RegexOptions.CultureInvariant|RegexOptions.NonBacktracking)) Fail("Use an AAA/BBB currency ticker.");
            var quantity=Positive(row,"quantity",1e12); var bid=Positive(row,"bid");
            if(Positive(row,"ask")<bid) Fail("Ask must be at least bid.");
            var start=Instant(row,"start"); if(row.ContainsKey("end")&&Instant(row,"end")<start) Fail("End must not precede start.");
            Number(row,"filledQuantity",0,quantity);
            if(row.ContainsKey("filledPrice")) Positive(row,"filledPrice"); Text(row,"error",500,false);
            if(Text(row,"kind",20)=="strategy"&&++strategies>500) Fail("At most 500 strategies.");
        }
        foreach(var pair in rows)
        {
            var row=pair.Value; var kind=Text(row,"kind",20); var strategy=Id(row,"strategyId");
            if(kind=="strategy") { if(row.ContainsKey("parentId")||pair.Key!=strategy) Fail("Strategies must be roots with matching strategy identifiers."); }
            else
            {
                var parentId=Id(row,"parentId",false);
                if(!rows.TryGetValue(parentId,out var parent)) Fail("Invalid execution parent.");
                if(Text(parent!,"kind",20)!=(kind=="order"?"strategy":"order")||strategy!=Id(parent!,"strategyId")||Text(row,"ticker",7)!=Text(parent!,"ticker",7)||Instant(row,"start")<Instant(parent!,"start")) Fail("Invalid execution hierarchy or parent association.");
            }
        }
        var seen=new HashSet<string>(StringComparer.Ordinal); var points=0;
        foreach(var node in Array(data,"series",500))
        {
            var series=Object(node); Keys(series,"strategyId","points"); var strategy=Id(series,"strategyId");
            if(!seen.Add(strategy)||!rows.TryGetValue(strategy,out var root)||Text(root,"kind",20)!="strategy") Fail("Series require unique strategy roots.");
            var samples=Array(series,"points",256,2); points+=samples.Count; double previous=-1;
            foreach(var sample in samples)
            {
                var point=Object(sample); Keys(point,"time","bid","ask"); var time=Instant(point,"time");
                if(time<=previous||Positive(point,"ask")<Positive(point,"bid")) Fail("Series times must increase and ask must be at least bid."); previous=time;
            }
        }
        if(points>12000) Fail("At most 12000 price points.");
        if(data.ContainsKey("pageSize")) Number(data,"pageSize",1,25,true,true);
        if(data.ContainsKey("selectedId")&&!rows.ContainsKey(Id(data,"selectedId"))) Fail("Selected row must exist.");
        Boolean(data,"demo");
    }
    private static double Instant(JsonObject value,string key)=>Number(value,key,0,LastInstant,true,true);
    private static void Style(JsonObject style)
    {
        Keys(style,"theme","accent","background","panel","text","muted","grid","bid","ask","strategy","statuses","rowHeight","fontSize");
        if(style.ContainsKey("theme")) Choice(style,"theme",["graphite","paper","terminal"]);
        foreach(var key in new[]{"accent","background","panel","text","muted","grid","bid","ask","strategy"}) if(style.ContainsKey(key)) Color(style,key);
        if(style.ContainsKey("statuses")) { var colors=Object(style["statuses"]); Keys(colors,Statuses); foreach(var pair in colors) Color(colors,pair.Key); }
        if(style.ContainsKey("rowHeight")) Number(style,"rowHeight",28,40,true,true);
        if(style.ContainsKey("fontSize")) Number(style,"fontSize",11,16,true,true);
    }
    private static void Color(JsonObject value,string key)
    {
        if(!Regex.IsMatch(Text(value,key,7,true,7),"^#[0-9a-fA-F]{6}$",RegexOptions.CultureInvariant|RegexOptions.NonBacktracking)) Fail("Use a six-digit hex color.");
    }
    private static double Positive(JsonObject value,string key,double maximum=double.MaxValue)
    {
        var number=Number(value,key,0,maximum); if(number<=0) Fail(key+" must be positive."); return number;
    }
}
