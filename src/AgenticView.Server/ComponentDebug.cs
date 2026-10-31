using System.Text;
using System.Text.Json.Nodes;

namespace AgenticView.Server;

/// <summary>Scoped native-component diagnostics. Commands are data, never scripts or selectors.</summary>
public sealed partial class ControlStore
{
    private static readonly string[] DebugOperations=["inspect","styles","click","doubleClick","focus","input","key","scroll","navigate","viewport","metrics","profile","layers"];
    private static readonly string[] DebugProperties=["display","visibility","opacity","position","width","height","min-width","max-width","min-height","max-height","padding","padding-top","padding-right","padding-bottom","padding-left","margin","margin-top","margin-right","margin-bottom","margin-left","gap","row-gap","column-gap","font-size","font-family","font-weight","line-height","letter-spacing","color","background-color","border-width","border-radius","overflow","overflow-x","overflow-y","pointer-events","animation-duration","transition-duration","transform","z-index","contain","content-visibility","will-change","isolation","transform-style"];
    private const int DebugClientCap=128,DebugSessionCap=512,DebugCommandCap=2048,DebugSessionCommandCap=256;
    private void InitializeComponentDebug()
    {
        Execute("""
            CREATE TABLE IF NOT EXISTS debug_clients(id TEXT PRIMARY KEY,proof TEXT NOT NULL,payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS debug_sessions(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,client_id TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(run_id,request_id));
            CREATE TABLE IF NOT EXISTS debug_commands(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,payload TEXT NOT NULL,UNIQUE(session_id,request_id));
            CREATE INDEX IF NOT EXISTS debug_command_queue ON debug_commands(state,created);
            """);
        // A claimed operation may already have executed. Restart never puts it back in a queue.
        foreach(var job in DebugRows("SELECT payload FROM debug_commands WHERE state='running'")) {job["state"]="unknown";job["error"]="Server restarted after claim; operation is not replayed.";DebugSaveCommand(job);}
        foreach(var session in DebugRows("SELECT payload FROM debug_sessions")){if(Text(session,"state")=="closed")DebugCloseSession(session,Text(session,"reason"));if(session["background"] is JsonObject&&Text(session,"state")=="open"){session["backgroundAck"]=null;DebugSaveSession(session);}}
    }
    private List<JsonObject> DebugRows(string sql,params object[] values){var rows=new List<JsonObject>();using var command=Command(sql,values);using var reader=command.ExecuteReader();while(reader.Read())rows.Add(Parse(reader.GetString(0)));return rows;}
    private JsonObject DebugSession(string id)=>Scalar("SELECT payload FROM debug_sessions WHERE id=$p0",id) is string value?Parse(value):throw new HubError(404,"Debug session unavailable.");
    private JsonObject DebugClient(string id)=>Scalar("SELECT payload FROM debug_clients WHERE id=$p0",id) is string value?Parse(value):throw new HubError(404,"Debug client unavailable.");
    private void DebugSaveSession(JsonObject value)=>Execute("UPDATE debug_sessions SET payload=$p0 WHERE id=$p1",Json.Text(value),Text(value,"id"));
    private void DebugSaveCommand(JsonObject value)=>Execute("UPDATE debug_commands SET state=$p0,payload=$p1 WHERE id=$p2",Text(value,"state"),Json.Text(value),Text(value,"id"));
    private static JsonObject DebugPublic(JsonObject value){var result=Clone(value);result.Remove("claimToken");result.Remove("completionDigest");return result;}
    private void DebugCloseSession(JsonObject session,string reason)
    {
        if(Text(session,"state")!="closed"){session["state"]="closed";session["closedAt"]=Now;session["reason"]=reason;DebugSaveSession(session);}
        foreach(var command in DebugRows("SELECT payload FROM debug_commands WHERE session_id=$p0 AND state IN ('queued','running')",Text(session,"id"))){command["state"]=Text(command,"state")=="running"?"unknown":"cancelled";command["error"]=reason;DebugSaveCommand(command);}
    }
    private void DebugSweep()
    {
        foreach(var session in DebugRows("SELECT payload FROM debug_sessions")){
            if(Text(session,"state")!="open")continue;
            var client=DebugClient(Text(session,"clientId"));
            if(session["expiresAt"]!.GetValue<long>()<=Now)DebugCloseSession(session,"Debug lease expired.");
            else if(client["lastSeen"]!.GetValue<long>()<Now-120000)DebugCloseSession(session,"Debug client is offline.");
        }
        foreach(var command in DebugRows("SELECT payload FROM debug_commands WHERE state='running'"))if(command["deadline"]!.GetValue<long>()<=Now){command["state"]="unknown";command["error"]="Claim deadline elapsed; operation is not replayed.";DebugSaveCommand(command);}
    }
    private static string DebugClientId(JsonObject input){var id=ComponentValidator.Text(input,"clientId",36,true,36);if(!Guid.TryParseExact(id,"D",out var value))throw new HubError(400,"Debug clientId must be a UUID.");return value.ToString();}
    private string DebugClientAuth(JsonObject input)
    {
        var id=DebugClientId(input);var proof=ComponentValidator.Text(input,"clientToken",256,true,32);
        if(Scalar("SELECT proof FROM debug_clients WHERE id=$p0",id) is not string stored||!Authentication.Equal(stored,Hash(proof)))throw new HubError(403,"Invalid debug client proof.");return id;
    }
    public static JsonObject ComponentDebugCatalog()=>Json.Object(new{operations=DebugOperations,styleProperties=DebugProperties,commands=new{inspect="{operation:'inspect',componentId?:id,includeText?:boolean,limit?:integer1..100}",styles="{operation:'styles',componentId:id,target?:Target,properties?:knownCSSNames[0..32]}",click="{operation:'click'|'doubleClick'|'focus',componentId:id,target:Target}",input="{operation:'input',componentId:id,target:Target,value:string<=2000}",key="{operation:'key',componentId:id,target:Target,key:Enter|Space|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|Tab}",scroll="{operation:'scroll',componentId:id,target?:Target,x:finite(-100000..100000),y:finite(-100000..100000)}",navigate="{operation:'navigate',mode:focus|maximize|canvas|fit}",viewport="{operation:'viewport',zoom:finite0.001..16,steps?:integer1..120,intervalMs?:integer8..100,anchorX?:finite0..1,anchorY?:finite0..1,profileSeconds?:integer1..30,profileRestartCamera?:boolean(false)}",metrics="{operation:'metrics'}",profile="{operation:'profile',durationSeconds:integer1..30}",layers="{operation:'layers'}"},target="Prefer {ref: inspectedReference}; alternatively strict {role?:string<=80,name?:string<=160,index?:integer0..99}. Never mix forms; no selectors.",limits=new{clients=DebugClientCap,sessions=DebugSessionCap,commandsPerSession=DebugSessionCommandCap,commandsGlobal=DebugCommandCap,resultBytes=65536,clientTtlSeconds=120,claimSeconds=90,maxLeaseSeconds=7200,maxProfileSeconds=30,backgroundWidthMin=320,backgroundHeightMin=240,backgroundDimensionMax=4096,backgroundLeasesPerClient=1},scope="Own-run, proof-bound native component debugging only. No custom frames, operational actions, scripts, arbitrary selectors, URLs, screenshots or external UI automation. Frontend enforces allowed native controls and input authority. Hard history caps reject new requests rather than evict retry identities."});
    private static void DebugValidateCommand(JsonObject command)
    {
        Budget(command,16384);ComponentValidator.Choice(command,"operation",DebugOperations);var operation=Text(command,"operation");
        var keys=operation switch{
            "inspect"=>new[]{"operation","componentId","includeText","limit"},
            "styles"=>["operation","componentId","target","properties"],
            "input"=>["operation","componentId","target","value"],
            "key"=>["operation","componentId","target","key"],
            "scroll"=>["operation","componentId","target","x","y"],
            "viewport"=>["operation","zoom","steps","intervalMs","anchorX","anchorY","profileSeconds","profileRestartCamera"],
            "navigate"=>["operation","mode"],"profile"=>["operation","durationSeconds"],"metrics" or "layers"=>["operation"],
            _=>["operation","componentId","target"]};
        ComponentConfiguration.Keys(command,keys);
        if(command.ContainsKey("componentId"))ComponentValidator.Id(command,"componentId");
        if(operation is "click" or "doubleClick" or "focus" or "input" or "key" or "scroll" or "styles")ComponentValidator.Id(command,"componentId");
        if(command.ContainsKey("target")){
            var target=ComponentValidator.Object(command["target"]);ComponentConfiguration.Keys(target,"ref","role","name","index");
            if(target.ContainsKey("ref")){var reference=ComponentValidator.Text(target,"ref",80,true);if(reference.Length<2||reference[0]!='e'||!reference.Skip(1).All(char.IsAsciiLetterOrDigit)||target.Count!=1)throw new HubError(400,"Use target {ref: inspectedReference} alone; call ui_inspect for a fresh reference.");}
            if(target.ContainsKey("role"))ComponentValidator.Text(target,"role",80,true);
            if(target.ContainsKey("name"))ComponentValidator.Text(target,"name",160,true);
            if(target.ContainsKey("index"))ComponentValidator.Number(target,"index",0,99,true,true);
        }else if(operation is "click" or "doubleClick" or "focus" or "input" or "key")throw new HubError(400,"This debug command requires a typed target.");
        switch(operation){
            case "inspect":if(command.ContainsKey("includeText"))ComponentValidator.Boolean(command,"includeText");if(command.ContainsKey("limit"))ComponentValidator.Number(command,"limit",1,100,true,true);break;
            case "styles":if(command.ContainsKey("properties")){var seen=new HashSet<string>();foreach(var property in ComponentValidator.Array(command,"properties",32)){if(property is not JsonValue value||!value.TryGetValue<string>(out var name)||!DebugProperties.Contains(name)||!seen.Add(name))throw new HubError(400,"Unknown or repeated debug style property.");}}break;
            case "input":ComponentValidator.Text(command,"value",2000,true);break;
            case "key":ComponentValidator.Choice(command,"key",["Enter","Space","Escape","ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Home","End","Tab"]);break;
            case "scroll":ComponentValidator.Number(command,"x",-100000,100000,true);ComponentValidator.Number(command,"y",-100000,100000,true);break;
            case "navigate":ComponentValidator.Choice(command,"mode",["focus","maximize","canvas","fit"]);break;
            case "viewport":
                if(command.ContainsKey("profileRestartCamera")){ComponentValidator.Boolean(command,"profileRestartCamera");if(!command.ContainsKey("profileSeconds"))throw new HubError(400,"profileRestartCamera requires profileSeconds and recreates camera timelines only after native tracing acknowledges start.");}
                if(command.ContainsKey("profileSeconds"))ComponentValidator.Number(command,"profileSeconds",1,30,true,true);
                ComponentValidator.Number(command,"zoom",.001,16,true);
                if(command.ContainsKey("steps"))ComponentValidator.Number(command,"steps",1,120,true,true);
                if(command.ContainsKey("intervalMs"))ComponentValidator.Number(command,"intervalMs",8,100,true,true);
                foreach(var anchor in new[]{"anchorX","anchorY"})if(command.ContainsKey(anchor))ComponentValidator.Number(command,anchor,0,1,true);
                break;
            case "profile":ComponentValidator.Number(command,"durationSeconds",1,30,true,true);break;
        }
    }
    public JsonObject ComponentDebugClients(string runId,string runToken)
    {
        hub.VerifyRun(runId,runToken);lock(gate){DebugSweep();var clients=DebugRows("SELECT payload FROM debug_clients").Where(client=>client["lastSeen"]!.GetValue<long>()>=Now-120000&&((JsonArray)client["cardIds"]!).Any(id=>id!.GetValue<string>()==runId)).Select(client=>(JsonNode)Json.Object(new{clientId=Text(client,"id"),platform=Text(client,"platform"),visible=client["visible"]!.GetValue<bool>(),lastSeen=client["lastSeen"]!.GetValue<long>()})).ToArray();return new JsonObject{["clients"]=new JsonArray(clients)};}
    }
    public JsonObject ComponentDebugOpen(string runId,string runToken,string clientId,string requestId,int durationSeconds=300)
    {
        hub.VerifyRun(runId,runToken);var input=Json.Object(new{clientId,requestId,durationSeconds});clientId=DebugClientId(input);ComponentValidator.Id(input,"requestId");ComponentValidator.Number(input,"durationSeconds",1,7200,true,true);var digest=Hash(Canonical(input));
        lock(gate){DebugSweep();
            if(Scalar("SELECT digest FROM debug_sessions WHERE run_id=$p0 AND request_id=$p1",runId,requestId) is string old){if(old!=digest)throw new HubError(409,"Debug lease request content changed.");return DebugPublic(Parse((string)Scalar("SELECT payload FROM debug_sessions WHERE run_id=$p0 AND request_id=$p1",runId,requestId)!));}
            var client=DebugClient(clientId);if(client["lastSeen"]!.GetValue<long>()<Now-120000||!client["visible"]!.GetValue<bool>()||!((JsonArray)client["cardIds"]!).Any(id=>id!.GetValue<string>()==runId))throw new HubError(409,"Debug client must be online, visible and advertise this run.");
            if(Convert.ToInt64(Scalar("SELECT COUNT(*) FROM debug_sessions"))>=DebugSessionCap)throw new HubError(409,"Debug session history cap reached; retry identities are retained.");
            var session=Json.Object(new{id=Guid.NewGuid().ToString(),runId,clientId,requestId,state="open",createdAt=Now,expiresAt=Now+durationSeconds*1000L});Execute("INSERT INTO debug_sessions VALUES($p0,$p1,$p2,$p3,$p4,$p5)",Text(session,"id"),runId,clientId,requestId,digest,Json.Text(session));return DebugPublic(session);
        }
    }
    public JsonObject ComponentDebugCommand(string runId,string runToken,string sessionId,string requestId,JsonObject command)
    {
        hub.VerifyRun(runId,runToken);ComponentValidator.Id(Json.Object(new{sessionId,requestId}),"sessionId");ComponentValidator.Id(Json.Object(new{requestId}),"requestId");DebugValidateCommand(command);var digest=Hash(Canonical(command));
        lock(gate){DebugSweep();var session=DebugSession(sessionId);if(Text(session,"runId")!=runId)throw new HubError(403,"Debug session belongs to another run.");
            if(Scalar("SELECT digest FROM debug_commands WHERE session_id=$p0 AND request_id=$p1",sessionId,requestId) is string old){if(old!=digest)throw new HubError(409,"Debug command request content changed.");return DebugPublic(Parse((string)Scalar("SELECT payload FROM debug_commands WHERE session_id=$p0 AND request_id=$p1",sessionId,requestId)!));}
            if(Text(session,"state")!="open")throw new HubError(409,"Debug lease is closed.");
            if(Convert.ToInt64(Scalar("SELECT COUNT(*) FROM debug_commands"))>=DebugCommandCap||Convert.ToInt64(Scalar("SELECT COUNT(*) FROM debug_commands WHERE session_id=$p0",sessionId))>=DebugSessionCommandCap)throw new HubError(409,"Debug command history cap reached; retry identities are retained.");
            var job=Json.Object(new{id=Guid.NewGuid().ToString(),sessionId,runId,command,state="queued",createdAt=Now});Execute("INSERT INTO debug_commands VALUES($p0,$p1,$p2,$p3,$p4,$p5,$p6)",Text(job,"id"),sessionId,requestId,digest,"queued",job["createdAt"]!.GetValue<long>(),Json.Text(job));return DebugPublic(job);
        }
    }
    public JsonObject ComponentDebugResult(string runId,string runToken,string sessionId,string commandId)
    {
        hub.VerifyRun(runId,runToken);lock(gate){DebugSweep();var session=DebugSession(sessionId);if(Text(session,"runId")!=runId)throw new HubError(403,"Debug session belongs to another run.");return DebugPublic(Parse(Scalar("SELECT payload FROM debug_commands WHERE id=$p0 AND session_id=$p1",commandId,sessionId) as string??throw new HubError(404,"Debug command unavailable.")));}
    }
    public JsonObject ComponentDebugClose(string runId,string runToken,string sessionId)
    {
        hub.VerifyRun(runId,runToken);lock(gate){var session=DebugSession(sessionId);if(Text(session,"runId")!=runId)throw new HubError(403,"Debug session belongs to another run.");DebugCloseSession(session,"Debug lease closed by its owning run.");return DebugPublic(session);}
    }
    public JsonObject ComponentDebugPoll(JsonObject input)
    {
        Budget(input,65536);ComponentConfiguration.Keys(input,"clientId","clientToken","cardIds","visible","platform","backgroundTesting","background");DebugValidateBackgroundPoll(input);var id=DebugClientId(input);var proof=ComponentValidator.Text(input,"clientToken",256,true,32);if(!input.ContainsKey("visible"))throw new HubError(400,"visible is required.");var visible=ComponentValidator.Boolean(input,"visible");ComponentValidator.Choice(input,"platform",["desktop","browser"]);var cards=ComponentValidator.Array(input,"cardIds",512);var seen=new HashSet<string>();foreach(var card in cards){var value=ComponentValidator.Id(new JsonObject{["id"]=card?.DeepClone()},"id");if(!seen.Add(value))throw new HubError(400,"Duplicate debug card ID.");}
        lock(gate){
            DebugSweep();
            if(Scalar("SELECT proof FROM debug_clients WHERE id=$p0",id) is string old){if(!Authentication.Equal(old,Hash(proof)))throw new HubError(403,"Invalid debug client proof.");}
            else {if(Convert.ToInt64(Scalar("SELECT COUNT(*) FROM debug_clients"))>=DebugClientCap)throw new HubError(409,"Debug client history cap reached.");Execute("INSERT INTO debug_clients VALUES($p0,$p1,$p2)",id,Hash(proof),Json.Text(Json.Object(new{id,cardIds=cards,visible,platform=Text(input,"platform"),lastSeen=Now})));}
            var client=Json.Object(new{id,cardIds=cards,visible,platform=Text(input,"platform"),lastSeen=Now});client["backgroundTesting"]=input["backgroundTesting"]?.DeepClone()??JsonValue.Create(false);DebugBackgroundAck(id,input);Execute("UPDATE debug_clients SET payload=$p0 WHERE id=$p1",Json.Text(client),id);DebugSweep();
            var sessions=DebugRows("SELECT payload FROM debug_sessions WHERE client_id=$p0",id).Where(session=>Text(session,"state")=="open").ToList();
            foreach(var session in sessions.Where(session=>!seen.Contains(Text(session,"runId"))||session["background"] is JsonObject&&(Text(client,"platform")!="desktop"||client["backgroundTesting"]?.GetValue<bool>()!=true)).ToList()){DebugCloseSession(session,"Run no longer advertised by debug client.");sessions.Remove(session);}
            var jobs=new JsonArray();
            var hasRunning=DebugRows("SELECT payload FROM debug_commands WHERE state='running'").Any(job=>sessions.Any(session=>Text(session,"id")==Text(job,"sessionId")));
            if(!hasRunning){foreach(var job in DebugRows("SELECT payload FROM debug_commands WHERE state='queued' ORDER BY created,id")){
                var lease=sessions.FirstOrDefault(session=>Text(session,"id")==Text(job,"sessionId"));if(lease is null||!DebugCanClaim(lease,visible))continue;
                job["state"]="running";job["claimedAt"]=Now;job["deadline"]=Now+90000;job["claimToken"]=Convert.ToHexStringLower(System.Security.Cryptography.RandomNumberGenerator.GetBytes(24));DebugSaveCommand(job);
                jobs.Add(Json.Object(new{id=Text(job,"id"),sessionId=Text(job,"sessionId"),runId=Text(job,"runId"),command=job["command"]!.DeepClone(),claimToken=Text(job,"claimToken"),deadline=job["deadline"]!.GetValue<long>()}));break;
            }}
            return new JsonObject{["jobs"]=jobs,["sessions"]=new JsonArray(sessions.Select(session=>(JsonNode)DebugPollSession(session)).ToArray()),["pollMs"]=sessions.Count==0?5000:250};
        }
    }
    public JsonObject ComponentDebugComplete(JsonObject input)
    {
        Budget(input,73728);ComponentConfiguration.Keys(input,"clientId","clientToken","commandId","claimToken","state","result","error");ComponentValidator.Id(input,"commandId");ComponentValidator.Text(input,"claimToken",128,true,32);ComponentValidator.Choice(input,"state",["succeeded","failed"]);if(input.ContainsKey("result")){ComponentValidator.Object(input["result"]);if(Encoding.UTF8.GetByteCount(Json.Text(input["result"]!))>65536)throw new HubError(413,"Debug result exceeds 64KiB.");}if(input.ContainsKey("error"))ComponentValidator.Text(input,"error",2000,true);
        lock(gate){var id=DebugClientAuth(input);DebugSweep();var job=Parse(Scalar("SELECT payload FROM debug_commands WHERE id=$p0",Text(input,"commandId")) as string??throw new HubError(404,"Debug command unavailable."));var session=DebugSession(Text(job,"sessionId"));if(Text(session,"clientId")!=id||!Authentication.Equal(Text(job,"claimToken"),Text(input,"claimToken")))throw new HubError(403,"Invalid debug command claim.");
            var digest=Hash(Canonical(input));if(job["completionDigest"] is not null){if(Text(job,"completionDigest")!=digest)throw new HubError(409,"Debug completion content changed.");return Json.Object(new{acknowledged=true,commandId=Text(job,"id"),state=Text(job,"state")});}
            if(Text(job,"state")!="running")throw new HubError(409,"Debug command is no longer running; it will not be replayed.");job["state"]=Text(input,"state");job["result"]=input["result"]?.DeepClone();job["error"]=input["error"]?.DeepClone();job["finishedAt"]=Now;job["completionDigest"]=digest;DebugSaveCommand(job);return Json.Object(new{acknowledged=true,commandId=Text(job,"id"),state=Text(job,"state")});
        }
    }
    public JsonObject ComponentDebugDisconnect(JsonObject input)
    {
        Budget(input,1024);ComponentConfiguration.Keys(input,"clientId","clientToken");lock(gate){var id=DebugClientAuth(input);var client=DebugClient(id);client["visible"]=false;client["lastSeen"]=0;Execute("UPDATE debug_clients SET payload=$p0 WHERE id=$p1",Json.Text(client),id);foreach(var session in DebugRows("SELECT payload FROM debug_sessions WHERE client_id=$p0",id))DebugCloseSession(session,"Debug client disconnected.");return Json.Object(new{acknowledged=true});}
    }
}
