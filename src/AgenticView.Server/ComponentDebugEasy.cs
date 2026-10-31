using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace AgenticView.Server;

public sealed partial class ControlStore
{
    private static readonly string[] EasyActions=["click","type","press","scroll","focus","zoom","metrics","profile","layers"];
    private string EasyCapability(string id)=>id+"."+Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secrets.RunSecret),Encoding.UTF8.GetBytes("easy-ui:"+id)));
    private JsonObject EasySession(string debugId)
    {
        var parts=debugId.Split('.');
        if(parts.Length!=2||!Guid.TryParseExact(parts[0],"D",out _)||!Authentication.Equal(debugId,EasyCapability(parts[0])))throw new HubError(403,"Invalid debugId capability. Use ui_open with your own run credentials.");
        DebugSweep();var session=DebugSession(parts[0]);if(session["easy"] is not JsonObject)throw new HubError(403,"This lease was not opened by ui_open.");return session;
    }
    private static JsonObject EasyCall(string tool,object arguments)=>Json.Object(new{tool,arguments});
    private JsonObject EasyError(HubError error,string? debugId=null,string[]? allowed=null)=>Json.Object(new{state="error",error=error.Message,status=error.Status,allowedActions=allowed??[],supportedActions=EasyActions,recovery="For stale targets call ui_inspect. For expired/offline sessions call ui_open with your own runId/runToken. Never replay an unknown action with a new requestId.",nextCall=debugId is null||error.Message.Contains("lease",StringComparison.OrdinalIgnoreCase)||error.Status==403&&allowed is null?EasyCall("ui_open",new{runId="your-run-id",runToken="your-private-run-token"}):EasyCall("ui_inspect",new{debugId})});
    private JsonObject EasyQueue(JsonObject session,string requestId,JsonObject command)
        =>ComponentDebugCommand(Text(session,"runId"),hub.OwnedToken(Text(session,"runId")),Text(session,"id"),requestId,command);
    public async Task<JsonObject> UiOpen(string runId,string runToken,string? componentId=null)
    {
        try{
            hub.VerifyRun(runId,runToken);if(componentId is not null)ComponentValidator.Id(Json.Object(new{componentId}),"componentId");
            string capability,commandId;
            lock(gate){
                DebugSweep();var clients=((JsonArray)ComponentDebugClients(runId,runToken)["clients"]!).OfType<JsonObject>().Where(c=>c["visible"]!.GetValue<bool>()).OrderByDescending(c=>c["lastSeen"]!.GetValue<long>()).ToArray();
                if(clients.Length==0)throw new HubError(409,"No fresh visible client advertises this run. Open the card in the native viewer, then retry ui_open.");
                var clientId=Text(clients[0],"clientId");
                var session=DebugRows("SELECT payload FROM debug_sessions WHERE run_id=$p0 AND client_id=$p1",runId,clientId).FirstOrDefault(s=>Text(s,"state")=="open"&&s["easy"] is JsonObject easy&&Text(easy,"componentId")== (componentId??""));
                if(session is null){session=ComponentDebugOpen(runId,runToken,clientId,"easy-"+Guid.NewGuid().ToString(),300);session["easy"]=Json.Object(new{componentId=componentId??"",nextActionId=Guid.NewGuid().ToString(),targets=new JsonArray()});DebugSaveSession(session);}
                capability=EasyCapability(Text(session,"id"));
                var job=EasyQueue(session,"open-"+Guid.NewGuid().ToString(),Json.Object(new{operation="navigate",mode="maximize"}));job["easyThenInspect"]=true;DebugSaveCommand(job);commandId=Text(job,"id");
            }
            return await UiWait(capability,commandId);
        }catch(HubError error){return EasyError(error);}
    }
    public Task<JsonObject> UiOpenCard(string operatorToken,string cardId,string? componentId=null)
    {
        if(!Authentication.Equal(operatorToken,secrets.ViewerToken))return Task.FromResult(EasyError(new HubError(403,"Explicit operator/viewer authority is required.")));
        try{return UiOpen(cardId,hub.OwnedToken(cardId),componentId);}catch(HubError error){return Task.FromResult(EasyError(error));}
    }
    public async Task<JsonObject> UiInspect(string debugId,string? componentId=null)
    {
        try{string id;lock(gate){var session=EasySession(debugId);if(componentId is not null)ComponentValidator.Id(Json.Object(new{componentId}),"componentId");var easy=(JsonObject)session["easy"]!;if(componentId is not null){easy["componentId"]=componentId;DebugSaveSession(session);}id=Text(EasyQueueInspect(session,"inspect-"+Guid.NewGuid().ToString()),"id");}return await UiWait(debugId,id);}
        catch(HubError error){return EasyError(error,debugId);}
    }
    private JsonObject EasyQueueInspect(JsonObject session,string requestId)
    {
        var job=EasyQueue(session,requestId,EasyInspectCommand(session));
        ((JsonObject)session["easy"]!)["lastInspectionId"]=Text(job,"id");DebugSaveSession(session);return job;
    }
    private static JsonObject EasyInspectCommand(JsonObject session)
    {
        var command=Json.Object(new{operation="inspect",limit=100});var component=Text((JsonObject)session["easy"]!,"componentId");if(component.Length>0)command["componentId"]=component;return command;
    }
    public async Task<JsonObject> UiAction(string debugId,string requestId,string action,string? targetRef=null,string? value=null,string? key=null,double? x=null,double? y=null,double? zoom=null)
    {
        string[]? allowedForError=null;
        try{
            string id;lock(gate){
                var session=EasySession(debugId);ComponentValidator.Id(Json.Object(new{requestId}),"requestId");
                var input=Json.Object(new{action,targetRef,value,key,x,y,zoom});var digest=Hash(Canonical(input));
                var old=DebugRows("SELECT payload FROM debug_commands WHERE session_id=$p0 AND request_id=$p1",Text(session,"id"),requestId).FirstOrDefault();
                if(old is not null){if(Text(old,"easyInputDigest")!=digest)throw new HubError(409,"requestId was already used with different input. Retry the identical call or use nextActionId for a new action.");id=Text(old,"id");}
                else{
                    var easy=(JsonObject)session["easy"]!;
                    if(requestId!=Text(easy,"nextActionId"))throw new HubError(409,"Use the returned nextActionId as requestId for a new action.");
                    if(!EasyActions.Contains(action))throw new HubError(400,"Unknown action. Allowed actions: "+string.Join(", ",EasyActions));
                    var targeted=action is "click" or "type" or "press" or "scroll" or "focus";
                    if(!targeted&&targetRef is not null||action!="type"&&value is not null||action!="press"&&key is not null||action!="scroll"&&(x is not null||y is not null)||action!="zoom"&&zoom is not null)throw new HubError(400,"Only supply fields used by the chosen action.");
                    var operation=action switch{"type"=>"input","press"=>"key","zoom"=>"viewport",_=>action};var command=Json.Object(new{operation});
                    if(targeted){
                        var target=((JsonArray)easy["targets"]!).OfType<JsonObject>().FirstOrDefault(t=>Text(t,"ref")==targetRef);
                        if(target is null)throw new HubError(409,"Target ref is missing or stale. Call ui_inspect and use one of its current refs.");
                        var allowed=((JsonArray)target["allowedActions"]!).Select(n=>n!.GetValue<string>()).ToArray();allowedForError=allowed;
                        if(!allowed.Contains(action))throw new HubError(403,"Target allows only: "+string.Join(", ",allowed));
                        command["componentId"]=target["componentId"]!.DeepClone();command["target"]=Json.Object(new{@ref=targetRef});
                    }
                    if(action=="type"){if(value is null)throw new HubError(400,"type requires value (a string, including empty to clear).");command["value"]=value;}
                    if(action=="press"){if(key is null)throw new HubError(400,"press requires key. Use Enter, Space, Escape, arrows, Home, End or Tab.");command["key"]=key;}
                    if(action=="scroll"){command["x"]=x??0;command["y"]=y??0;}
                    if(action=="zoom"){if(zoom is null)throw new HubError(400,"zoom requires zoom between0.001 and16.");command["zoom"]=zoom.Value;}
                    if(action=="profile")command["durationSeconds"]=5;
                    var job=EasyQueue(session,requestId,command);job["easyInputDigest"]=digest;DebugSaveCommand(job);id=Text(job,"id");easy["nextActionId"]=Guid.NewGuid().ToString();DebugSaveSession(session);
                }
            }
            return await UiWait(debugId,id);
        }catch(HubError error){return EasyError(error,debugId,allowedForError);}
    }
    public async Task<JsonObject> UiWait(string debugId,string commandId)
    {
        try{
            ComponentValidator.Id(Json.Object(new{commandId}),"commandId");var until=Now+8000;
            while(true){
                lock(gate){
                    var session=EasySession(debugId);var job=ComponentDebugResult(Text(session,"runId"),hub.OwnedToken(Text(session,"runId")),Text(session,"id"),commandId);var state=Text(job,"state");
                    if(state=="succeeded"&&job["easyThenInspect"]?.GetValue<bool>()==true){var next=EasyQueueInspect(session,"after-"+commandId);commandId=Text(next,"id");continue;}
                    if(state=="succeeded"&&Text((JsonObject)job["command"]!,"operation")=="inspect"&&Text((JsonObject)session["easy"]!,"lastInspectionId")==Text(job,"id"))EasyRememberTargets(session,job["result"] as JsonObject);
                    var easy=(JsonObject)session["easy"]!;var targets=(JsonArray)easy["targets"]!;var pending=state is "queued" or "running";
                    if(!pending||Now>=until){
                        var nextId=Text(easy,"nextActionId");var next=pending?EasyCall("ui_wait",new{debugId,commandId}):state=="succeeded"?EasyCall("ui_action",new{debugId,requestId=nextId,action="metrics"}):EasyCall("ui_inspect",new{debugId});
                        return Json.Object(new{debugId,commandId,state=pending?"pending":state,result=job["result"]?.DeepClone(),error=job["error"]?.DeepClone(),targets=targets.DeepClone(),allowedActions=EasyActions,nextActionId=nextId,nextCall=next,recovery=state=="unknown"?"Outcome uncertain: never replay this action with a new requestId. Inspect current state before deciding what to do.":null});
                    }
                }
                await Task.Delay(100);
            }
        }catch(HubError error){return EasyError(error,debugId);}
    }
    private void EasyRememberTargets(JsonObject session,JsonObject? result)
    {
        var targets=new JsonArray();
        if(result?["components"] is JsonArray components)foreach(var component in components.OfType<JsonObject>()){
            if(component["targets"] is not JsonArray entries)continue;
            foreach(var entry in entries.OfType<JsonObject>()){
                if(targets.Count>=100)break;
                var reference=entry["ref"]?.GetValue<string>()??(entry["target"] as JsonObject)?["ref"]?.GetValue<string>();
                if(reference is null||reference.Length>100||entry["actions"] is not JsonArray actions||entry["visible"]?.GetValue<bool>()==false||entry["disabled"]?.GetValue<bool>()==true)continue;
                var allowed=actions.OfType<JsonValue>().Select(n=>n.TryGetValue<string>(out var a)?a:"").Select(a=>a switch{"input"=>"type","key"=>"press",_=>a}).Where(a=>EasyActions.Contains(a)&&a is not ("zoom" or "metrics" or "profile" or "layers")).Distinct().ToArray();
                if(allowed.Length==0)continue;
                var target=Json.Object(new{@ref=reference,label=Text(entry,"name"),role=Text(entry,"role"),componentId=Text(component,"id"),allowedActions=allowed});if(entry["field"] is JsonObject field)target["field"]=field.DeepClone();targets.Add(target);
            }
        }
        ((JsonObject)session["easy"]!)["targets"]=targets;DebugSaveSession(session);
    }
    public JsonObject UiClose(string debugId)
    {
        try{lock(gate){var session=EasySession(debugId);ComponentDebugClose(Text(session,"runId"),hub.OwnedToken(Text(session,"runId")),Text(session,"id"));return Json.Object(new{state="closed",message="Debugging closed. Queued commands cancelled; claimed commands are never replayed."});}}
        catch(HubError error){return EasyError(error);}
    }
}
