using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace AgenticView.Server;

/// <summary>Persistent session intent and bounded output. Execution belongs to a leased connector.</summary>
public sealed partial class ControlStore
{
    private const int SessionOutputRows = 4000, SessionOutputBytes = 4_194_304;
    public JsonObject ConfigureSessionLauncher(string runId,string token,string actionId,string label,string connectorId,string handler,string? machineId,string? remoteProfileId,string? confirmation)
    {
        hub.VerifyRun(runId,token); lock(gate) {
            var config=Configuration(runId); var actions=(JsonArray)config["actions"]!.DeepClone();
            var action=Json.Object(new{id=actionId,label,kind="session",target=connectorId,handler,confirmation=confirmation??"",fields=new JsonArray()});
            if(actionId.Length>90) throw new HubError(400,"Launcher action IDs are limited to 90 characters.");
            if(machineId is not null) { action["connection"]=Json.Object(new{machineId}); if(remoteProfileId is not null) action["connection"]!["remoteProfileId"]=remoteProfileId; }
            var index=actions.ToList().FindIndex(a=>a is JsonObject item && Text(item,"id")==actionId); if(index<0) actions.Add(action); else actions[index]=action;
            var result=Configure(runId,token,Json.Object(new{actions,application=new{name=hub.GetRun(runId)?["name"]?.GetValue<string>()??label}}));
            hub.PublishNext(runId,token,new JsonArray(Json.Object(new{op="upsert",component=new{id="launcher-"+actionId,title=label,kind="session-launcher",data=new{actionId,label="New session"}}})));
            return result;
        }
    }
    private void InitializeSessions() { Execute("""
        CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,target TEXT NOT NULL,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS session_requests(request_id TEXT PRIMARY KEY,digest TEXT NOT NULL,session_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS session_output(session_id TEXT NOT NULL,sequence INTEGER NOT NULL,bytes INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(session_id,sequence));
        CREATE TABLE IF NOT EXISTS session_reports(session_id TEXT NOT NULL,report_id TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(session_id,report_id));
        CREATE INDEX IF NOT EXISTS session_target ON sessions(target);
        """);
        var digest=false; using(var c=Command("PRAGMA table_info(session_reports)")) using(var r=c.ExecuteReader()) while(r.Read()) digest|=r.GetString(1)=="digest";
        if(!digest) Execute("ALTER TABLE session_reports ADD COLUMN digest TEXT NOT NULL DEFAULT ''");
        var known = new List<JsonObject>(); using (var c = Command("SELECT payload FROM sessions LIMIT 1000")) using (var r = c.ExecuteReader()) while (r.Read()) known.Add(Parse(r.GetString(0)));
        foreach (var session in known) if (hub.GetRun(Text(session, "runId")) is not null) hub.MarkManagedSession(Text(session, "runId"), Text(session, "runToken"), Text(session, "id"));
    }
    private JsonObject Session(string id) => Scalar("SELECT payload FROM sessions WHERE id=$p0",id) is string value ? Parse(value) : throw new HubError(404,"Session unavailable.");
    private void SaveSession(JsonObject s) { s["updatedAt"]=Now; Execute("INSERT INTO sessions VALUES($p0,$p1,$p2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",Text(s,"id"),Text(s,"target"),Json.Text(s)); }
    private static JsonObject SessionPublic(JsonObject s)
    {
        var result=Clone(s);
        foreach(var key in new[]{"target","handler","runToken","claimToken","owner","leaseUntil","generation","prompt","originalPrompt","prompts","outputBytes","registrationKey"}) result.Remove(key);
        return result;
    }
    public JsonObject SessionView(string id) { lock(gate) { var s=Session(id); var result=SessionPublic(s); if(Text(s,"desiredState")=="running" && s["leaseUntil"]!.GetValue<long>()<Now && Text(s,"state") is "running" or "starting" or "recovering") { result["state"]="offline"; result["message"]="Waiting for the owning connector. The card and session intent are retained."; } result["components"]=SessionComponents(s); return result; } }
    private JsonArray SessionComponents(JsonObject s) => new((hub.GetRun(Text(s,"runId"))?["components"] as JsonObject ?? new JsonObject()).Select(p=>p.Value).OfType<JsonObject>().Select(c=>(JsonNode)Json.Object(new{id=Text(c,"id"),title=Text(c,"title"),kind=Text(c,"kind")})).ToArray());
    private JsonObject? SessionRequest(JsonObject input)
    {
        var id=ComponentValidator.Id(input,"requestId");
        using var c=Command("SELECT digest,session_id FROM session_requests WHERE request_id=$p0",id); using var r=c.ExecuteReader();
        if(!r.Read()) return null; if(r.GetString(0)!=Hash(Canonical(input))) throw new HubError(409,"Request ID already has different content."); return SessionPublic(Session(r.GetString(1)));
    }
    private void RememberSessionRequest(JsonObject input,string id) => Execute("INSERT INTO session_requests VALUES($p0,$p1,$p2)",Text(input,"requestId"),Hash(Canonical(input)),id);
    public JsonObject DraftSession(JsonObject input)
    {
        Budget(input,16384); lock(gate) {
            if(SessionRequest(input) is JsonObject existing) { EnsureSessionCard(Session(Text(existing,"id"))); return existing; }
            var source=ComponentValidator.Id(input,"launcherRunId"); var actionId=ComponentValidator.Id(input,"actionId");
            if(hub.GetRun(source) is null) throw new HubError(404,"Launcher unavailable.");
            var config=Configuration(source); var action=((JsonArray)config["actions"]!).OfType<JsonObject>().FirstOrDefault(a=>Text(a,"id")==actionId) ?? throw new HubError(404,"Session action unavailable.");
            if(Text(action,"kind")!="session" || Text(action,"target")=="agent") throw new HubError(400,"A session requires a configured connector session profile.");
            if(Convert.ToInt64(Scalar("SELECT COUNT(*) FROM sessions"))>=1000) throw new HubError(429,"Session capacity reached.");
            var id=new Guid(SHA256.HashData(Encoding.UTF8.GetBytes("session-draft:"+Text(input,"requestId"))).AsSpan(0,16)).ToString(); var registration=hub.Register(Json.Object(new{requestId="session-"+id,registrationKey=Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secrets.RunSecret),Encoding.UTF8.GetBytes("draft:"+Canonical(input)))),agentId="session-"+id,name=Text(action,"label"),role="Agent session",context="Persistent session; execution runs on its configured connector."}));
            var runId=Text(registration,"runId"); var runToken=Text(registration,"runToken");
            hub.MakeApplication(runId,runToken,Json.Object(new{name=Text(action,"label"),description="Persistent agent session"}));
            hub.MarkManagedSession(runId,runToken,id);
            hub.SetApplicationSize(runId,runToken,Json.Object(new{width=640,height=720,sizing="content"}));
            var s=Json.Object(new{id,runId,runToken,launcherRunId=source,actionId,name=Text(action,"label"),agentType=Text(action,"handler"),target=Text(action,"target"),handler=Text(action,"handler"),configurationVersion=Text(config,"version"),confirmation=Text(action,"confirmation"),state="draft",desiredState="paused",generation=0,attempt=0,recoveryCount=0,autoRecover=true,replacementAvailable=false,createdAt=Now,updatedAt=Now,outputRevision=0L,outputBytes=0L,owner="",claimToken="",leaseUntil=0L,prompt="",originalPrompt="",prompts=new JsonArray()});
            if(action["connection"] is JsonObject connection) s["connection"]=connection.DeepClone();
            SaveSession(s); RememberSessionRequest(input,id);
            EnsureSessionCard(s);
            return SessionPublic(s);
        }
    }
    private void EnsureSessionCard(JsonObject s)
    {
        hub.MarkManagedSession(Text(s,"runId"),Text(s,"runToken"),Text(s,"id"));
        var view=hub.GetRun(Text(s,"runId")); var components=view?["components"] as JsonObject ?? new JsonObject(); var operations=new JsonArray();
        if(!components.ContainsKey("session-plan")) operations.Add(Json.Object(new{op="upsert",component=new{id="session-plan",title="Current task list",kind="markdown",data=new{text="- [ ] Enter a prompt and start the session\n- [ ] Follow progress and reported components"}}}));
        if(!components.ContainsKey("session-console")) operations.Add(Json.Object(new{op="upsert",component=new{id="session-console",title="Agent session",kind="agent-session",data=new{sessionId=Text(s,"id")}}}));
        if(operations.Count>0) {hub.SetSessionStatus(Text(s,"runId"),Text(s,"runToken"),"active");hub.PublishNext(Text(s,"runId"),Text(s,"runToken"),operations);}
    }
    public JsonObject ControlSession(string id,JsonObject input)
    {
        lock(gate) {JsonObject result; Execute("BEGIN IMMEDIATE"); try {result=ControlSessionCore(id,input);Execute("COMMIT");}catch{Execute("ROLLBACK");throw;}var s=Session(id);hub.SetSessionStatus(Text(s,"runId"),Text(s,"runToken"),Text(s,"state")=="completed"?"completed":"active");return result;}
    }
    private JsonObject ControlSessionCore(string id,JsonObject input)
    {
        Budget(input,131072); lock(gate) {
            if(SessionRequest(input) is JsonObject prior) { if(Text(prior,"id")!=id) throw new HubError(409,"Request belongs to another session."); return prior; }
            var s=Session(id); ComponentValidator.Choice(input,"operation",["start","prompt","pause","resume","stop"]); var op=Text(input,"operation");
            if(op is "start" or "prompt" or "resume") {
                var config=Configuration(Text(s,"launcherRunId"));
                if(Text(s,"configurationVersion")!=Text(config,"version")) throw new HubError(409,"Launcher configuration changed. Create a new session from the current definition.");
                if(Text(s,"confirmation").Length>0 && (!ComponentValidator.Boolean(input,"confirmed") || Text(input,"configurationVersion")!=Text(s,"configurationVersion"))) throw new HubError(409,"Review and confirm this session action before executing it.");
                var prompt=ComponentValidator.Text(input,"prompt",65536,false);
                if(op is "start" or "prompt" && string.IsNullOrWhiteSpace(prompt)) throw new HubError(400,"A prompt is required.");
                if(Text(s,"desiredState")=="running" && Text(s,"state") is "running" or "queued" or "starting" or "recovering") throw new HubError(409,"Pause or wait for the current turn before sending another prompt.");
                if(op=="start" && Text(s,"state")!="draft") throw new HubError(409,"This session has already started.");
                if(op=="resume" && Text(s,"state")=="draft") throw new HubError(409,"Start this draft with a prompt first.");
                if(prompt.Length>0) { s["prompt"]=prompt; if(Text(s,"originalPrompt").Length==0) s["originalPrompt"]=prompt; var prompts=(JsonArray)s["prompts"]!; prompts.Add(Json.Object(new{time=Now,text=prompt})); while(prompts.Count>50 || Json.Text(prompts).Length>131072) prompts.RemoveAt(0); }
                else s["prompt"]="Continue the interrupted task. Inspect existing state before retrying any side effects. Do not repeat completed work.";
                s["desiredState"]="running"; s["state"]="queued"; s["recoveryBudgetUsed"]=0; s["recoveryMode"]=ComponentValidator.Boolean(s,"replacementAvailable")?"handoff":Text(s,"nativeSessionId").Length>0?"native":s["attempt"]!.GetValue<int>()>0?"handoff":"new";
                s["replacementAvailable"]=false; s["lastError"]=null;
            } else { s["desiredState"]=op=="pause"?"paused":"completed"; s["state"]=op=="pause"?"paused":"completed"; s["message"]=op=="pause"?"Turn interrupted. Resume continues the provider session when supported.":"Stopped by operator."; }
            s["generation"]=s["generation"]!.GetValue<int>()+1; SaveSession(s); RememberSessionRequest(input,id); return SessionPublic(s);
        }
    }
    public JsonArray PollSessions(string connectorId,string token,JsonObject input)
    {
        Budget(input,16384); var owner=ComponentValidator.Id(input,"owner"); lock(gate) {
            ConnectorAuth(connectorId,token); var rows=new List<JsonObject>(); using(var c=Command("SELECT payload FROM sessions WHERE target=$p0 LIMIT 1000",connectorId)) using(var r=c.ExecuteReader()) while(r.Read()) rows.Add(Parse(r.GetString(0)));
            var result=new JsonArray();
            foreach(var s in rows) {
                if(result.Count>=8) break;
                if(Text(s,"owner")==owner && s["leaseUntil"]!.GetValue<long>()>Now) { s["leaseUntil"]=Now+45000; SaveSession(s); result.Add(SessionJob(s)); continue; }
                if(Text(s,"desiredState")!="running" || s["leaseUntil"]!.GetValue<long>()>Now) continue;
                if(Text(s,"state") is "running" or "starting" or "recovering") { s["state"]="recovering"; s["recoveryMode"]=Text(s,"nativeSessionId").Length>0?"native":"handoff"; s["message"]="Recovering after connector interruption. Existing side effects must be inspected before continuing."; }
                s["owner"]=owner; s["claimToken"]=Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32)); s["leaseUntil"]=Now+45000; s["attempt"]=s["attempt"]!.GetValue<int>()+1;
                if(Text(s,"state")!="recovering") s["state"]="starting"; SaveSession(s);
                result.Add(SessionJob(s));
            }
            return result;
        }
    }
    private JsonObject SessionJob(JsonObject s)
    {
        var job=Clone(s);job["reportingToken"]=SessionToken(s);job.Remove("runToken");
        if(Text(s,"recoveryMode")!="handoff")return job;
        var export=ExportSessionCore(s);
        var output=export["output"]!["entries"]!.AsArray().TakeLast(12).Select(e=>{var item=(JsonObject)e!.DeepClone();var text=Text(item,"text");if(text.Length>4096)item["text"]=text[..4096]+" [entry truncated]";return (JsonNode)item;}).ToArray();
        var plans=(export["components"] as JsonObject??new JsonObject()).Select(p=>p.Value).OfType<JsonObject>().Where(c=>Text(c,"kind") is "markdown" or "checklist").OrderByDescending(c=>Text(c,"id")=="session-plan").Take(4).Select(c=>{
            var copy=Clone(c);if(Text(c,"kind")=="markdown"){var data=copy["data"]!.AsObject();var text=Text(data,"text");if(text.Length>8192)data["text"]=text[..8192]+" [plan truncated]";}else{var data=copy["data"]!.AsObject();data["items"]=new JsonArray(data["items"]!.AsArray().Take(20).Select(item=>item!.DeepClone()).ToArray());}return (JsonNode)copy;
        }).ToArray();
        job["handoff"]=Json.Object(new{session=SessionPublic(s),originalPrompt=Text(s,"originalPrompt"),planState=new JsonArray(plans),componentDescriptions=SessionComponents(s),recentPrompts=((JsonArray)s["prompts"]!).TakeLast(4).Select(p=>{var value=(JsonObject)p!.DeepClone();var text=Text(value,"text");if(text.Length>4096)value["text"]=text[..4096]+" [prompt truncated]";return value;}).ToArray(),recentOutput=new JsonArray(output),notice="Bounded monitoring handoff. Full provider history remains on the execution machine. Inspect previous side effects before retrying; output and recent prompts may be truncated."});return job;
    }
    public JsonObject ReportSession(string connectorId,string token,string id,JsonObject input)
    {
        lock(gate) { Execute("BEGIN IMMEDIATE"); try { var result=ReportSessionCore(connectorId,token,id,input); Execute("COMMIT"); return result; } catch { Execute("ROLLBACK"); throw; } }
    }
    private JsonObject ReportSessionCore(string connectorId,string token,string id,JsonObject input)
    {
        Budget(input,524288); lock(gate) {
            ConnectorAuth(connectorId,token); var s=Session(id);
            var reportId=ComponentValidator.Id(input,"reportId"); var digest=Hash(Canonical(input));
            if(Text(s,"target")!=connectorId) throw new HubError(403,"Session belongs to another connector.");
            if(Scalar("SELECT digest FROM session_reports WHERE session_id=$p0 AND report_id=$p1",id,reportId) is string prior) { if(prior!=digest) throw new HubError(409,"Report ID already has different content."); return SessionPublic(s); }
            if(!Authentication.Equal(Text(s,"claimToken"),Text(input,"claimToken")) || Text(s,"owner")!=Text(input,"owner") || s["leaseUntil"]!.GetValue<long>()<Now) throw new HubError(409,"Session lease lost. Stop the owned process before reconnecting.");
            var generation=(int)ComponentValidator.Number(input,"generation",0,int.MaxValue,true,true);
            if(generation!=s["generation"]!.GetValue<int>()) { if(Text(s,"desiredState")!="running" && Text(input,"outcome").Length>0) { s["owner"]="";s["claimToken"]="";s["leaseUntil"]=0L;SaveSession(s);Execute("INSERT INTO session_reports(session_id,report_id,digest) VALUES($p0,$p1,$p2)",id,reportId,digest); } return SessionPublic(s); }
            if(input.ContainsKey("agentType")) { ComponentValidator.Choice(input,"agentType",["codex","claude","opencode","custom"]); s["agentType"]=input["agentType"]!.DeepClone(); }
            if(input.ContainsKey("transport")) { ComponentValidator.Choice(input,"transport",["local","ssh"]); s["transport"]=input["transport"]!.DeepClone(); }
            var entries=input["entries"] as JsonArray ?? new JsonArray(); if(entries.Count>100) throw new HubError(413,"Output batch is too large.");
            foreach(var node in entries) { var entry=ComponentValidator.Object(node); ComponentValidator.Choice(entry,"stream",["stdout","stderr","system"]); ComponentValidator.Choice(entry,"format",["text","markdown","html","json","code"]); ComponentValidator.Text(entry,"text",32768); ComponentValidator.Choice(entry,"level",["info","warn","error","debug"],"info"); ComponentValidator.Text(entry,"label",160,false); entry["sequence"]=s["outputRevision"]!.GetValue<long>()+1; entry["time"]=Now; s["outputRevision"]=entry["sequence"]!.DeepClone(); var body=Json.Text(entry); var bytes=Encoding.UTF8.GetByteCount(body); Execute("INSERT INTO session_output VALUES($p0,$p1,$p2,$p3)",id,entry["sequence"]!.GetValue<long>(),bytes,body); s["outputBytes"]=s["outputBytes"]!.GetValue<long>()+bytes; }
            TrimSessionOutput(s);
            if(input.ContainsKey("nativeSessionId")) { var native=ComponentValidator.Text(input,"nativeSessionId",200,true,1); if(native.Any(char.IsControl) || native.StartsWith('-')) throw new HubError(400,"Invalid provider session identity."); s["nativeSessionId"]=native; }
            var outcome=ComponentValidator.Text(input,"outcome",40,false);
            if(outcome.Length==0) { s["state"]="running"; s["message"]="Agent turn is running."; s["leaseUntil"]=Now+45000; }
            else {
                ComponentValidator.Choice(input,"outcome",["completed","paused","stopped","failed","resume-failed","stalled","auth-required"]);
                s["owner"]=""; s["claimToken"]=""; s["leaseUntil"]=0L;
                if(outcome is "completed" or "paused" or "stopped") { s["state"]=outcome=="paused"?"paused":"completed"; s["desiredState"]=s["state"]!.DeepClone(); s["message"]=outcome=="completed"?"Turn finished. Send another prompt to continue this session.":"Turn stopped; session history retained."; }
                else if(outcome=="auth-required") { s["state"]="error"; s["desiredState"]="paused"; s["lastError"]="SSH authentication requires replacement credentials."; s["message"]="Update this machine in Settings → SSH machines, then resume. No credentials expire on a schedule."; }
                else {
                    s["lastError"]=outcome=="stalled"?"Configured silence deadline expired.":outcome=="resume-failed"?"Native resume failed.":"Agent process was interrupted or failed.";
                    var count=s["recoveryBudgetUsed"]?.GetValue<int>()??0; var replace=outcome is "resume-failed" or "stalled" || Text(s,"nativeSessionId").Length==0;
                    s["replacementAvailable"]=replace;
                    if(ComponentValidator.Boolean(s,"autoRecover") && count<2) { s["recoveryBudgetUsed"]=count+1; s["recoveryCount"]=s["recoveryCount"]!.GetValue<int>()+1; s["state"]="recovering"; s["desiredState"]="running"; s["recoveryMode"]=replace?"handoff":"native"; s["prompt"]="Recover the interrupted task. Inspect existing effects and components before continuing. Never repeat uncertain commands automatically."; s["message"]=replace?"Export retained; starting a replacement provider session in this card.":"Resuming the existing provider session."; if(replace) { s["previousNativeSessionId"]=s["nativeSessionId"]?.DeepClone(); s.Remove("nativeSessionId"); } }
                    else { s["state"]="error"; s["desiredState"]="paused"; s["message"]="Automatic recovery budget exhausted. Review output before resuming."; }
                }
            }
            SaveSession(s); Execute("INSERT INTO session_reports(session_id,report_id,digest) VALUES($p0,$p1,$p2)",id,reportId,digest); Execute("DELETE FROM session_reports WHERE session_id=$p0 AND rowid NOT IN (SELECT rowid FROM session_reports WHERE session_id=$p0 ORDER BY rowid DESC LIMIT 256)",id);
            hub.SetSessionStatus(Text(s,"runId"),Text(s,"runToken"),Text(s,"state")=="completed"?"completed":Text(s,"state")=="error"?"error":"active");
            return SessionPublic(s);
        }
    }
    private void TrimSessionOutput(JsonObject s)
    {
        var id=Text(s,"id"); var sequence=s["outputRevision"]!.GetValue<long>(); Execute("DELETE FROM session_output WHERE session_id=$p0 AND sequence<=$p1",id,sequence-SessionOutputRows);
        var bytes=Convert.ToInt64(Scalar("SELECT COALESCE(SUM(bytes),0) FROM session_output WHERE session_id=$p0",id));
        while(bytes>SessionOutputBytes) { using var c=Command("SELECT sequence,bytes FROM session_output WHERE session_id=$p0 ORDER BY sequence LIMIT 1",id); using var r=c.ExecuteReader(); if(!r.Read()) break; var first=r.GetInt64(0); var size=r.GetInt64(1); r.Close(); Execute("DELETE FROM session_output WHERE session_id=$p0 AND sequence=$p1",id,first); bytes-=size; }
        s["outputBytes"]=bytes;
    }
    public JsonObject SessionOutput(string id,long after,int limit,string filter)
    {
        lock(gate) { var s=Session(id); after=Math.Max(0,after); limit=Math.Clamp(limit,1,200); if(filter.Length>1000) throw new HubError(400,"Filter is too long."); var entries=new JsonArray(); long next=after; var earliest=Convert.ToInt64(Scalar("SELECT COALESCE(MIN(sequence),0) FROM session_output WHERE session_id=$p0",id));
            var bytes=0; using var c=Command("SELECT sequence,payload FROM session_output WHERE session_id=$p0 AND sequence>$p1 ORDER BY sequence LIMIT 4000",id,after); using var r=c.ExecuteReader();
            while(r.Read()) { var body=r.GetString(1); var entry=Parse(body); var match=filter.Length==0 || Text(entry,"text").Contains(filter,StringComparison.OrdinalIgnoreCase); var size=Encoding.UTF8.GetByteCount(body); if(match && entries.Count>0 && bytes+size>262144) break; next=r.GetInt64(0); if(match) { entries.Add(entry); bytes+=size; } if(entries.Count>=limit) break; }
            return Json.Object(new{entries,next,earliest,truncated=after<earliest-1}); }
    }
    public JsonObject ExportSession(string id) { lock(gate) return ExportSessionCore(Session(id)); }
    public string SessionHtml(string id,long sequence)
    {
        lock(gate) { Session(id); if(Scalar("SELECT payload FROM session_output WHERE session_id=$p0 AND sequence=$p1",id,sequence) is not string value) throw new HubError(404,"Output entry is outside the retained window."); return Text(Parse(value),"text"); }
    }
    private JsonObject ExportSessionCore(JsonObject s)
    {
        var view=hub.GetRun(Text(s,"runId")); var components=view?["components"] as JsonObject ?? new JsonObject();
        var entries=new List<JsonNode>(); var bytes=0;
        using(var c=Command("SELECT payload FROM session_output WHERE session_id=$p0 ORDER BY sequence DESC LIMIT 200",Text(s,"id"))) using(var r=c.ExecuteReader()) while(r.Read()) { var body=r.GetString(0); var size=Encoding.UTF8.GetByteCount(body); if(entries.Count>0 && bytes+size>262144) break; entries.Add(Parse(body)); bytes+=size; }
        entries.Reverse(); var output=Json.Object(new{entries=new JsonArray(entries.ToArray()),next=s["outputRevision"]!.GetValue<long>(),truncated=entries.Count<s["outputRevision"]!.GetValue<long>()});
        return Json.Object(new{schemaVersion=1,exportedAt=Now,session=SessionPublic(s),originalPrompt=Text(s,"originalPrompt"),prompts=s["prompts"]!.DeepClone(),output,components=components.DeepClone(),notice="Bounded monitoring handoff, not a complete provider context export. Inspect existing side effects before continuing. Installation credentials are excluded."});
    }
    public JsonObject PublishSession(string id,string token,JsonObject input)
    {
        Budget(input,524288); lock(gate) {
            var s=Session(id); if(!Authentication.Equal(token,SessionToken(s))) throw new HubError(403,"Invalid session reporting credentials.");
            var request=ComponentValidator.Id(input,"requestId"); var decorated=Clone(input); decorated["requestId"]="r:"+id+":"+Hash(request)[..48];
            if(SessionRequest(decorated) is not null) return Json.Object(new{accepted=true,duplicate=true});
            var operations=ComponentValidator.Array(input,"operations",64,1);
            foreach(var node in operations) { var op=ComponentValidator.Object(node); if(Text(op,"op") is not ("upsert" or "remove" or "append" or "context" or "style")) throw new HubError(400,"Session reporting supports component and context updates only."); var cid=Text(op,"op")=="upsert"?Text(ComponentValidator.Object(op["component"]),"id"):Text(op,"componentId"); if(cid=="session-console") throw new HubError(400,"The session console is reserved."); }
            var ack=hub.PublishNext(Text(s,"runId"),Text(s,"runToken"),(JsonArray)operations.DeepClone()); RememberSessionRequest(decorated,id); return ack;
        }
    }
    public JsonObject RegisterSessionChild(string id,string token,JsonObject input)
    {
        Budget(input,16384);lock(gate){var s=Session(id);if(!Authentication.Equal(token,SessionToken(s)))throw new HubError(403,"Invalid session reporting credentials.");var registration=Clone(input);registration["parentId"]=s["runId"]!.DeepClone();registration["parentToken"]=s["runToken"]!.DeepClone();return hub.Register(registration);}
    }
    private string SessionToken(JsonObject s) => Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secrets.RunSecret),Encoding.UTF8.GetBytes("session-report:"+Text(s,"id")+":"+s["generation"]+":"+s["attempt"])));
}
