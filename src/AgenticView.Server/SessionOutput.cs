using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace AgenticView.Server;

/// <summary>Normalizes structured CLI events; unknown events stay inert and bounded.</summary>
public static class SessionOutput
{
    public sealed record Parsed(string? NativeId,JsonObject? Entry,bool Error=false);
    public static Parsed Parse(string provider,string line,string stream="stdout")
    {
        if(line.Length>32768) line=line[..32740]+" … [line truncated]";
        line=Regex.Replace(line,@"\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B\[[0-?]*[ -/]*[@-~]","",RegexOptions.CultureInvariant,TimeSpan.FromMilliseconds(100));
        JsonObject? data=null; try { data=JsonNode.Parse(line) as JsonObject; } catch(System.Text.Json.JsonException) { }
        string? id=null; var text=line; var format="text"; var label=stream=="stderr"?"Diagnostics":"Output"; var error=false;
        if(data is not null) {
            var type=Json.String(data,"type");
            id=Json.String(data,"session_id"); if(id.Length==0) id=Json.String(data,"sessionID");
            if(provider=="codex") {
                if(type=="thread.started") return new(Json.String(data,"thread_id"),null);
                if(type is "item.started" or "item.updated" or "turn.started" or "turn.completed") return new(null,null);
                if(type=="item.completed" && data["item"] is JsonObject item) {
                    var kind=Json.String(item,"type");
                    if(kind=="agent_message") { text=Json.String(item,"text"); format="markdown"; label="Assistant"; }
                    else if(kind=="command_execution") { text=Json.String(item,"command")+"\n"+Json.String(item,"aggregated_output"); format="code"; label="Command"; }
                    else { text=item.ToJsonString(); format="json"; label=kind; }
                } else { text=data["error"]?["message"]?.GetValue<string>()??Json.String(data,"message"); if(text.Length==0) return new(null,null); error=type is "error" or "turn.failed"; }
            } else if(provider=="claude") {
                if(type=="system") return new(id.Length>0?id:null,null);
                if(type=="assistant") { text=string.Join("\n",(data["message"]?["content"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().Where(c=>Json.String(c,"type")=="text").Select(c=>Json.String(c,"text"))); format="markdown"; label="Assistant"; }
                else if(type=="result") { text=Json.String(data,"result"); error=ComponentValidator.Boolean(data,"is_error"); label="Result"; format="markdown"; }
                else return new(id.Length>0?id:null,null);
            } else if(provider=="opencode") {
                if(type=="text") { text=data["part"]?["text"]?.GetValue<string>()??Json.String(data,"text"); format="markdown"; label="Assistant"; }
                else if(type=="error") { text=data["error"]?.ToJsonString()??line; error=true; }
                else return new(id.Length>0?id:null,null);
            } else if(type=="session") return new(Json.String(data,"id"),null);
            else if(type=="output") { text=Json.String(data,"text"); format=Json.String(data,"format"); if(!new[]{"text","markdown","html","json","code"}.Contains(format)) format="text"; error=Json.String(data,"level")=="error"; }
            else { format="json"; text=data.ToJsonString(); }
        }
        if(text.Length==0) return new(string.IsNullOrEmpty(id)?null:id,null,error);
        if(text.Length>32768) text=text[..32740]+" … [entry truncated]";
        if(format=="markdown" && (text.TrimStart().StartsWith("<!doctype html",StringComparison.OrdinalIgnoreCase) || text.TrimStart().StartsWith("<html",StringComparison.OrdinalIgnoreCase))) format="html";
        return new(string.IsNullOrEmpty(id)?null:id,Json.Object(new{stream,format,text,level=error||stream=="stderr"?"error":"info",label}),error);
    }
}
