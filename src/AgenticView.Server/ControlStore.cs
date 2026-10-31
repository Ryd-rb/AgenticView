using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace AgenticView.Server;

/// <summary>Durable, bounded-message dispatch. Only a connector or the owning agent executes an action.</summary>
public sealed partial class ControlStore : IDisposable
{
    private readonly object gate = new();
    private readonly SqliteConnection db;
    private readonly Hub hub;
    private readonly Secrets secrets;
    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    public ControlStore(RuntimeConfig config, Hub hub)
    {
        this.hub = hub; secrets = config.Secrets;
        db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Path.Combine(config.DataDir, "controls.sqlite") }.ToString()); db.Open();
        Execute("""
            PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS configurations(run_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS connectors(id TEXT PRIMARY KEY,proof TEXT NOT NULL,payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS application_definitions(run_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS application_imports(request_id TEXT PRIMARY KEY,digest TEXT NOT NULL,run_id TEXT NOT NULL,complete INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS invocations(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,target TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,payload TEXT NOT NULL,UNIQUE(run_id,request_id));
            CREATE INDEX IF NOT EXISTS inbox ON invocations(target,state,created);
            CREATE INDEX IF NOT EXISTS action_history ON invocations(run_id,created DESC);
            """);
        InitializeSessions();
        InitializeSshCredentials();
        InitializeQuickText();
        InitializeComponentDebug();
    }
    private SqliteCommand Command(string sql, params object[] values) { var c = db.CreateCommand(); c.CommandText = sql; for (var i=0;i<values.Length;i++) c.Parameters.AddWithValue("$p"+i,values[i]); return c; }
    private void Execute(string sql, params object[] values) { using var c=Command(sql,values); c.ExecuteNonQuery(); }
    private object? Scalar(string sql, params object[] values) { using var c=Command(sql,values); return c.ExecuteScalar(); }
    private static JsonObject Clone(JsonObject value) => (JsonObject)value.DeepClone();
    private static JsonObject Parse(string value) => JsonNode.Parse(value)!.AsObject();
    private static string Text(JsonObject value,string key) => Json.String(value,key);
    private static string Hash(string value) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    private static string Canonical(JsonNode? value) => value switch { JsonObject obj => "{"+string.Join(",",obj.OrderBy(p=>p.Key,StringComparer.Ordinal).Select(p=>System.Text.Json.JsonSerializer.Serialize(p.Key)+":"+Canonical(p.Value)))+"}", JsonArray arr=>"["+string.Join(",",arr.Select(Canonical))+"]", _=>value?.ToJsonString()??"null" };
    private string ConnectorToken(string id) => Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secrets.RunSecret),Encoding.UTF8.GetBytes("connector:"+id)));
    private void ConnectorAuth(string id,string token) { if (Scalar("SELECT id FROM connectors WHERE id=$p0",id) is null || !Authentication.Equal(ConnectorToken(id),token)) throw new HubError(403,"Invalid connector credentials."); }
    private static void Budget(JsonObject input,int max=524288) { ComponentValidator.Budget(input); if (Encoding.UTF8.GetByteCount(Json.Text(input))>max) throw new HubError(413,"Control message budget exceeded."); }
    public JsonObject RegisterConnector(JsonObject input)
    {
        Budget(input,16384); var id=ComponentValidator.Id(input,"id"); var proof=Hash(ComponentValidator.Text(input,"registrationKey",256,true,32)); var name=ComponentValidator.Text(input,"name",160,true,1);
        lock(gate) {
            var old=Scalar("SELECT proof FROM connectors WHERE id=$p0",id) as string;
            if(old is not null && !Authentication.Equal(old,proof)) throw new HubError(409,"Connector ID belongs to another registration key.");
            var view=Json.Object(new{id,name,lastSeen=Now});
            Execute("INSERT INTO connectors VALUES($p0,$p1,$p2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",id,proof,Json.Text(view));
            return Json.Object(new{id,token=ConnectorToken(id),pollSeconds=1,leaseSeconds=120});
        }
    }
    public JsonObject Configure(string id,string token,JsonObject input)
    {
        hub.VerifyRun(id,token); Budget(input,131072);
        var actions=ComponentValidator.Array(input,"actions",64); ValidateActions(actions);
        JsonObject? application=null;
        if(input["application"] is not null) { application=Clone(ComponentValidator.Object(input["application"])); ComponentValidator.Text(application,"name",160,true,1); ComponentValidator.Text(application,"description",2000,false); }
        application ??= hub.GetRun(id)?["application"] as JsonObject;
        var config=Json.Object(new {version=Hash(Canonical(input)),actions});
        if(application is not null) config["application"]=application.DeepClone();
        if(application is not null) hub.MakeApplication(id,token,application);
        lock(gate) { Execute("INSERT INTO configurations VALUES($p0,$p1) ON CONFLICT(run_id) DO UPDATE SET payload=excluded.payload",id,Json.Text(config)); }
        return Clone(config);
    }
    private static void ValidateActions(JsonArray actions)
    {
        var seen=new HashSet<string>();
        foreach(var node in actions) {
            var action=ComponentValidator.Object(node); var aid=ComponentValidator.Id(action,"id"); if(!seen.Add(aid)) throw new HubError(400,"Duplicate action ID.");
            ComponentValidator.Text(action,"label",160,true,1); ComponentValidator.Text(action,"description",2000,false);
            ComponentValidator.Choice(action,"kind",["command","prompt","query","edit","history","logs","custom","session"]);
            var target=ComponentValidator.Id(action,"target"); if(target!="agent") ComponentValidator.Id(action,"handler");
            ComponentValidator.Text(action,"confirmation",2000,false);
            if(action.ContainsKey("connection")) { if(Text(action,"kind")!="session") throw new HubError(400,"Connection recipes belong to session actions."); var connection=ComponentValidator.Object(action["connection"]); Keys(connection,"machineId","remoteProfileId"); ComponentValidator.Id(connection,"machineId"); ComponentValidator.Id(connection,"remoteProfileId",false); }
            ValidateFields(action);
        }
    }
    private static void ValidateFields(JsonObject action)
    {
        if(!action.ContainsKey("fields")) action["fields"]=new JsonArray(); var keys=new HashSet<string>();
        foreach(var node in ComponentValidator.Array(action,"fields",24)) {
            var field=ComponentValidator.Object(node); if(!keys.Add(ComponentValidator.Id(field,"key"))) throw new HubError(400,"Duplicate field key.");
            ComponentValidator.Text(field,"label",160,true,1); ComponentValidator.Choice(field,"type",["text","multiline","number","select","toggle","json"]); ComponentValidator.Boolean(field,"required");
            if(field.ContainsKey("min")) ComponentValidator.Number(field,"min"); if(field.ContainsKey("max")) ComponentValidator.Number(field,"max");
            if(field.ContainsKey("min") && field.ContainsKey("max") && field["min"]!.GetValue<double>()>field["max"]!.GetValue<double>()) throw new HubError(400,"Field range is inverted.");
            if(Text(field,"type")=="select") foreach(var option in ComponentValidator.Array(field,"options",100,1)) if(option is not JsonValue v || !v.TryGetValue<string>(out var s) || s.Length>500) throw new HubError(400,"Invalid select option.");
        }
    }
    public JsonObject Configuration(string id) { lock(gate) return Scalar("SELECT payload FROM configurations WHERE run_id=$p0",id) is string value ? Parse(value) : Json.Object(new{version="",actions=Array.Empty<object>()}); }
    private static void ValidateInput(JsonObject action,JsonObject input)
    {
        Budget(input,131072); var fields=((JsonArray)action["fields"]!).OfType<JsonObject>().ToDictionary(f=>Text(f,"key"));
        // Native readers use bounded, documented envelopes. Local profiles still decide which operations exist.
        var standard=Text(action,"kind") switch { "logs"=>new[]{"cursor","filter","level"}, "query"=>new[]{"cursor","limit","filter","sort","columns"}, "edit"=>new[]{"operation","row","rows","previousRow","rowId","expectedVersion","changes"}, "history"=>new[]{"rowId","row","cursor"}, _=>Array.Empty<string>() };
        standard=[..standard,"componentId","rowKey"];
        if(input.ContainsKey("componentId")) ComponentValidator.Id(input,"componentId");
        if(input.ContainsKey("rowKey")) {var identity=ComponentValidator.Object(input["rowKey"]);if(identity.Count>32)throw new HubError(400,"Compound row key is too large.");foreach(var pair in identity){ComponentValidator.Id(new JsonObject{["key"]=pair.Key},"key");ComponentConfiguration.Scalar(pair.Value);}}
        foreach(var field in fields.Values) {
            var key=Text(field,"key"); var present=input.TryGetPropertyValue(key,out var value) && value is not null;
            if(!present) { if(ComponentValidator.Boolean(field,"required")) throw new HubError(400,$"{key} is required."); continue; }
            switch(Text(field,"type")) {
                case "text": case "multiline": ComponentValidator.Text(input,key,16384); break;
                case "select": var option=ComponentValidator.Text(input,key,500); if(!((JsonArray)field["options"]!).Any(o=>o!.GetValue<string>()==option)) throw new HubError(400,"Unsupported selection."); break;
                case "number": ComponentValidator.Number(input,key,field["min"]?.GetValue<double>()??-1e15,field["max"]?.GetValue<double>()??1e15); break;
                case "toggle": ComponentValidator.Boolean(input,key); break;
                case "json": break;
            }
        }
        foreach(var key in input.Select(p=>p.Key)) if(!fields.ContainsKey(key) && !standard.Contains(key)) throw new HubError(400,$"Undeclared action field: {key}.");
        foreach(var key in new[]{"cursor","filter","level"}) if(input.ContainsKey(key) && standard.Contains(key)) ComponentValidator.Text(input,key,key=="filter"?1000:key=="cursor"?65536:300);
        if(input.ContainsKey("limit") && standard.Contains("limit")) ComponentValidator.Number(input,"limit",1,200,true,true);
        if(standard.Contains("sort") && input.ContainsKey("sort")) foreach(var node in ComponentValidator.Array(input,"sort",4)) { var sort=ComponentValidator.Object(node); ComponentValidator.Id(sort,"key"); ComponentValidator.Choice(sort,"direction",["asc","desc"]); }
        if(standard.Contains("columns") && input.ContainsKey("columns")) foreach(var column in ComponentValidator.Array(input,"columns",64)) ComponentValidator.Id(new JsonObject{["key"]=column?.DeepClone()},"key");
        if(standard.Contains("changes")) {
            if(input.ContainsKey("operation")) ComponentValidator.Choice(input,"operation",["add","update","delete","bulk"]);
            foreach(var key in new[]{"row","previousRow","changes"}) if(input.ContainsKey(key)) ComponentValidator.Object(input[key]);
            if(input.ContainsKey("rows")) foreach(var row in ComponentValidator.Array(input,"rows",200,1)) ComponentValidator.Object(row);
            if(!input.ContainsKey("row") && !input.ContainsKey("rows") && !input.ContainsKey("changes")) throw new HubError(400,"A row mutation requires row, rows or changes.");
        }
    }
    public JsonObject Invoke(string runId,JsonObject input)
    {
        Budget(input,131072); var request=ComponentValidator.Id(input,"requestId"); var actionId=ComponentValidator.Id(input,"actionId"); var values=ComponentValidator.Object(input["input"]); var digest=Hash(Canonical(input));
        lock(gate) {
            Sweep();
            using(var c=Command("SELECT digest,payload FROM invocations WHERE run_id=$p0 AND request_id=$p1",runId,request)) using(var reader=c.ExecuteReader()) if(reader.Read()) { if(reader.GetString(0)!=digest) throw new HubError(409,"Request ID already has different content."); return Public(Parse(reader.GetString(1))); }
            if(hub.GetRun(runId) is null) throw new HubError(404,"Card unavailable. Restore its archive first.");
            var config=Configuration(runId); var action=((JsonArray)config["actions"]!).OfType<JsonObject>().FirstOrDefault(a=>Text(a,"id")==actionId) ?? throw new HubError(404,"Action unavailable.");
            if(Text(action,"kind")=="session") throw new HubError(400,"Use a session-launcher to create a draft before starting an agent session.");
            if(Text(input,"definitionVersion")!=Text(config,"version")) throw new HubError(409,"Action configuration changed. Reload and review it again.");
            if(Text(action,"confirmation").Length>0 && !ComponentValidator.Boolean(input,"confirmed")) throw new HubError(409,"This action requires explicit confirmation.");
            ValidateInput(action,values);
            GridValidation.Action(hub.GetRun(runId)!,actionId,values);
            if(Convert.ToInt64(Scalar("SELECT COUNT(*) FROM invocations WHERE state IN ('queued','running')"))>=1000 || Convert.ToInt64(Scalar("SELECT COUNT(*) FROM invocations WHERE run_id=$p0 AND state IN ('queued','running')",runId))>=100) throw new HubError(429,"Action queue is full.");
            var id=Guid.NewGuid().ToString(); var target=Text(action,"target")=="agent"?"agent:"+runId:"connector:"+Text(action,"target");
            var job=Json.Object(new{id,runId,actionId,kind=Text(action,"kind"),handler=Text(action,"handler"),input=values,definitionVersion=Text(config,"version"),state="queued",createdAt=Now,confirmed=ComponentValidator.Boolean(input,"confirmed")});
            Execute("INSERT INTO invocations VALUES($p0,$p1,$p2,$p3,$p4,'queued',$p5,$p6)",id,runId,request,digest,target,Now,Json.Text(job)); return Clone(job);
        }
    }
    private void Save(JsonObject job) => Execute("UPDATE invocations SET state=$p0,payload=$p1 WHERE id=$p2",Text(job,"state"),Json.Text(job),Text(job,"id"));
    private void Sweep()
    {
        var expired=new List<JsonObject>();
        using(var c=Command("SELECT payload FROM invocations WHERE state IN ('queued','running')")) using(var r=c.ExecuteReader()) while(r.Read()) { var job=Parse(r.GetString(0)); if(Text(job,"state")=="queued" && Now-job["createdAt"]!.GetValue<long>()>600000 || Text(job,"state")=="running" && Now-job["startedAt"]!.GetValue<long>()>120000) expired.Add(job); }
        foreach(var job in expired) { job["state"]=Text(job,"state")=="queued"?"cancelled":"unknown"; job["finishedAt"]=Now; job["error"]="Delivery deadline expired. Check the target before retrying; execution may have occurred."; Save(job); }
    }
    public JsonArray Poll(string id,string token,bool agent)
    {
        if(agent) hub.VerifyRun(id,token);
        lock(gate) {
            if(!agent) { ConnectorAuth(id,token); var p=Parse((string)Scalar("SELECT payload FROM connectors WHERE id=$p0",id)!); p["lastSeen"]=Now; Execute("UPDATE connectors SET payload=$p0 WHERE id=$p1",Json.Text(p),id); }
            Sweep(); var target=(agent?"agent:":"connector:")+id; var result=new JsonArray();
            // One outstanding execution per consumer. Poll does not redeliver a claimed command.
            if(Convert.ToInt64(Scalar("SELECT COUNT(*) FROM invocations WHERE target=$p0 AND state='running'",target))>0) return result;
            if(Scalar("SELECT payload FROM invocations WHERE target=$p0 AND state='queued' ORDER BY created,id LIMIT 1",target) is string payload) {
                var job=Parse(payload); job["state"]="running"; job["startedAt"]=Now; job["claimToken"]=Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(24)); Save(job); result.Add(Clone(job));
            }
            return result;
        }
    }
    public JsonObject Complete(string id,string token,bool agent,JsonObject input)
    {
        if(agent) hub.VerifyRun(id,token); Budget(input); var invocation=ComponentValidator.Id(input,"invocationId"); var claim=ComponentValidator.Text(input,"claimToken",128); var state=ComponentValidator.Text(input,"state",20); if(state is not ("succeeded" or "failed" or "unknown")) throw new HubError(400,"Completion must succeed, fail or report an unknown outcome.");
        if(input["error"] is not null) ComponentValidator.Text(input,"error",4000,false);
        lock(gate) {
            if(!agent) ConnectorAuth(id,token);
            var target=(agent?"agent:":"connector:")+id;
            var payload=Scalar("SELECT payload FROM invocations WHERE id=$p0 AND target=$p1",invocation,target) as string ?? throw new HubError(404,"Invocation unavailable."); var job=Parse(payload);
            if(!Authentication.Equal(Text(job,"claimToken"),claim)) throw new HubError(403,"Invalid invocation claim.");
            var digest=Hash(Canonical(input)); if(job["completionDigest"] is not null) { if(Text(job,"completionDigest")!=digest) throw new HubError(409,"Completion already differs."); return Public(job); }
            if(Text(job,"state") is not ("running" or "unknown")) throw new HubError(409,"Invocation cannot complete.");
            job["state"]=state; job["finishedAt"]=Now; job["result"]=input["result"]?.DeepClone(); job["error"]=input["error"]?.DeepClone(); job["completionDigest"]=digest; Budget(job); Save(job);
            // Read responses are disposable windows, not a persisted copy of an unbounded source log/database.
            Execute("DELETE FROM invocations WHERE run_id=$p0 AND state IN ('succeeded','failed','cancelled') AND json_extract(payload,'$.kind') IN ('logs','query','history') AND id NOT IN (SELECT id FROM invocations WHERE run_id=$p0 AND json_extract(payload,'$.kind') IN ('logs','query','history') ORDER BY created DESC,id DESC LIMIT 64)",Text(job,"runId"));
            return Public(job);
        }
    }
    private static JsonObject Public(JsonObject job) { var result=Clone(job); result.Remove("claimToken"); result.Remove("completionDigest"); return result; }
    public JsonObject Invocation(string runId,string id) { lock(gate) { Sweep(); return Public(Parse(Scalar("SELECT payload FROM invocations WHERE run_id=$p0 AND id=$p1",runId,id) as string ?? throw new HubError(404,"Invocation unavailable."))); } }
    public JsonArray History(string runId,int limit,int offset=0) { lock(gate) { Sweep(); var result=new JsonArray(); using var c=Command("SELECT payload FROM invocations WHERE run_id=$p0 ORDER BY created DESC,id DESC LIMIT $p1 OFFSET $p2",runId,Math.Clamp(limit,1,100),Math.Clamp(offset,0,1000000)); using var r=c.ExecuteReader(); while(r.Read()) { var item=Public(Parse(r.GetString(0))); if(result.Count>0 && Encoding.UTF8.GetByteCount(result.ToJsonString())+Encoding.UTF8.GetByteCount(item.ToJsonString())>524288) break; result.Add(item); } return result; } }
    public void Dispose() { lock(gate) db.Dispose(); }
}
