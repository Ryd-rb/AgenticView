using System.Text.Json.Nodes;

namespace AgenticView.Server;

/// <summary>Optional text requests use the existing durable inbox/connector protocol; no model runs in the hub.</summary>
public sealed partial class ControlStore
{
    private void InitializeQuickText() => Execute("CREATE TABLE IF NOT EXISTS quick_text(run_id TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(run_id,id))");
    private void SaveQuickText(JsonObject state) => Execute("INSERT INTO quick_text VALUES($p0,$p1,$p2) ON CONFLICT(run_id,id) DO UPDATE SET payload=excluded.payload", Text(state,"runId"), Text(state,"id"), Json.Text(state));
    private static JsonObject QuickTextPublic(JsonObject state) { var result=Clone(state); result.Remove("pendingRequest"); return result; }
    public JsonObject QuickTextSettings(string runId,string token)
    {
        hub.VerifyRun(runId,token); lock(gate) { var rows=new JsonArray(); using var c=Command("SELECT payload FROM quick_text WHERE run_id=$p0 ORDER BY id LIMIT 64",runId); using var r=c.ExecuteReader(); while(r.Read()) rows.Add(QuickTextPublic(Parse(r.GetString(0)))); return new JsonObject { ["configurations"]=rows }; }
    }
    public JsonObject ConfigureQuickText(string runId,string token,string id,JsonObject input)
    {
        hub.VerifyRun(runId,token); Budget(input,8192); ComponentValidator.Id(Json.Object(new{id}),"id");
        lock(gate)
        {
            var old=Scalar("SELECT payload FROM quick_text WHERE run_id=$p0 AND id=$p1",runId,id) as string;
            if(old is null && (Convert.ToInt64(Scalar("SELECT COUNT(*) FROM quick_text"))>=512 || Convert.ToInt64(Scalar("SELECT COUNT(*) FROM quick_text WHERE run_id=$p0",runId))>=64)) throw new HubError(429,"Quick-text configuration capacity reached.");
            var enabled=ComponentValidator.Boolean(input,"enabled",true);
            if(!enabled && old is not null)
            {
                var stopped=Parse(old); stopped["enabled"]=false; stopped["state"]="cancelled"; CancelQuickText(stopped,"Quick-text configuration disabled; ignore late results."); stopped.Remove("pendingRequest"); stopped.Remove("pendingInvocationId"); SaveQuickText(stopped); return QuickTextPublic(stopped);
            }
            var actionId=ComponentValidator.Id(input,"actionId"); var config=Configuration(runId); var action=TextAction(config,actionId);
            var callback=ComponentValidator.Id(input,"callbackActionId",false); if(callback.Length>0) TextAction(config,callback);
            var interval=input.ContainsKey("intervalSeconds")?ComponentValidator.Number(input,"intervalSeconds",15,86400,true,true):60;
            var timeout=input.ContainsKey("timeoutSeconds")?ComponentValidator.Number(input,"timeoutSeconds",5,120,true,true):30;
            ComponentValidator.Choice(input,"target",["title","context","component"],"component");
            var componentId=input.ContainsKey("componentId")?ComponentValidator.Id(input,"componentId"):"quick-text-"+id;
            if(componentId.Length>120) throw new HubError(400,"Quick-text component ID is too long.");
            var label=input.ContainsKey("label")?ComponentValidator.Text(input,"label",160,true,1):"Status summary";
            var normalized=Json.Object(new{actionId,callbackActionId=callback,intervalSeconds=interval,timeoutSeconds=timeout,target=Text(input,"target"),componentId,label,enabled});
            var version=Hash(Canonical(normalized)+Text(config,"version"));
            if(old is not null && Text(Parse(old),"version")==version && ComponentValidator.Boolean(Parse(old),"enabled")==enabled) return QuickTextPublic(Parse(old));
            if(old is not null) CancelQuickText(Parse(old),"Quick-text configuration replaced; ignore late results.");
            var state=Clone(normalized); state["id"]=id; state["runId"]=runId; state["version"]=version; state["definitionVersion"]=Text(config,"version"); state["nextDueAt"]=Now; state["failures"]=0; state["state"]=enabled?"waiting":"cancelled";
            SaveQuickText(state); return QuickTextPublic(state);
        }
    }
    private static JsonObject TextAction(JsonObject config,string id)
    {
        var action=((JsonArray)config["actions"]!).OfType<JsonObject>().FirstOrDefault(a=>Text(a,"id")==id) ?? throw new HubError(404,"Quick-text action unavailable.");
        if(Text(action,"kind") is not ("prompt" or "custom") || Text(action,"confirmation").Length>0 || !((JsonArray)action["fields"]!).OfType<JsonObject>().Any(f=>Text(f,"key")=="context" && Text(f,"type")=="json")) throw new HubError(400,"Automatic text actions/callbacks require a prompt/custom action with a declared JSON context field and no confirmation. Execution stays with its owning agent or connector.");
        return action;
    }
    private void CancelTextJob(string id,string reason)
    {
        if(id.Length==0 || Scalar("SELECT payload FROM invocations WHERE id=$p0",id) is not string payload) return;
        var job=Parse(payload); if(Text(job,"state") is not ("queued" or "running")) return;
        job["state"]=Text(job,"state")=="queued"?"cancelled":"unknown"; job["error"]=reason; job["finishedAt"]=Now; Save(job);
    }
    private void CancelQuickText(JsonObject state,string reason)
    {
        var id=Text(state,"pendingInvocationId");
        if(id.Length==0 && state["pendingRequest"] is JsonObject request)
            id=Scalar("SELECT id FROM invocations WHERE run_id=$p0 AND request_id=$p1",Text(state,"runId"),Text(request,"requestId")) as string ?? "";
        CancelTextJob(id,reason);
    }
    private static JsonObject TextContext(JsonObject view)
    {
        var summaries=new JsonArray(); var chars=0;
        foreach(var component in ((JsonObject)view["components"]!).Select(p=>p.Value).OfType<JsonObject>().Take(64))
        {
            var text=Text(component,"kind")=="markdown"?Text((JsonObject)component["data"]!,"text"):Text(component,"kind")=="progress"?Json.Text(component["data"]!):"";
            text=text[..Math.Min(text.Length,Math.Max(0,Math.Min(4096,8192-chars)))]; chars+=text.Length;
            summaries.Add(Json.Object(new{id=Text(component,"id"),title=Text(component,"title"),kind=Text(component,"kind"),text}));
        }
        var context=Text(view,"context");
        return Json.Object(new{cardId=Text(view,"id"),name=Text(view,"name"),status=Text(view,"status"),context=context[..Math.Min(context.Length,2000)],observedAt=Now,updatedAt=view["updatedAt"],components=summaries});
    }
    private void FailQuickText(JsonObject state,string message,bool uncertain=false)
    {
        var failures=(state["failures"]?.GetValue<int>()??0)+1; state["failures"]=failures; state["error"]=message; state["state"]=uncertain?"unknown":"failed";
        if(uncertain || failures>=3) state["enabled"]=false;
        state["nextDueAt"]=Now+(long)(Math.Min(3600,state["intervalSeconds"]!.GetValue<double>()*Math.Pow(2,failures))*1000);
        state.Remove("pendingRequest"); state.Remove("pendingInvocationId"); SaveQuickText(state);
    }
    public void TickQuickText()
    {
        lock(gate)
        {
            Sweep(); var states=new List<JsonObject>(); using(var c=Command("SELECT payload FROM quick_text LIMIT 512")) using(var r=c.ExecuteReader()) while(r.Read()) states.Add(Parse(r.GetString(0)));
            var dispatched=0;
            foreach(var state in states)
            {
                if(!ComponentValidator.Boolean(state,"enabled")) continue;
                var runId=Text(state,"runId"); var view=hub.GetRun(runId); var config=Configuration(runId);
                if(view is null || Text(config,"version")!=Text(state,"definitionVersion"))
                {
                    CancelQuickText(state,"Card archived or action definition changed; ignore late text."); state["enabled"]=false; state["state"]="cancelled"; state["error"]="Card archived or action definition changed. Reconfigure explicitly to resume."; state.Remove("pendingRequest"); state.Remove("pendingInvocationId"); SaveQuickText(state); continue;
                }
                try
                {
                    var pending=Text(state,"pendingInvocationId");
                    if(pending.Length>0)
                    {
                        var job=Invocation(runId,pending); var status=Text(job,"state");
                        if(status is "queued" or "running")
                        {
                            if(Now-state["dispatchedAt"]!.GetValue<long>()>=state["timeoutSeconds"]!.GetValue<double>()*1000) { CancelTextJob(pending,"Quick-text deadline expired; late results ignored."); FailQuickText(state,"Quick-text deadline expired. Inspect the target before re-enabling.",status=="running"); }
                            continue;
                        }
                        if(status!="succeeded") { FailQuickText(state,Text(job,"error"),status=="unknown"); continue; }
                        var result=job["result"] as JsonObject ?? throw new HubError(400,"Text action must return result {text:string}.");
                        var text=ComponentValidator.Text(result,"text",512,true,1).Trim(); if(text.Length==0) throw new HubError(400,"Text result is empty.");
                        var target=Text(state,"target");
                        if(target=="title") hub.Rename(runId,text[..Math.Min(text.Length,160)]);
                        else if(target=="context") hub.PublishNext(runId,hub.OwnedToken(runId),new JsonArray(Json.Object(new{op="context",text})));
                        else hub.PublishNext(runId,hub.OwnedToken(runId),new JsonArray(Json.Object(new{op="upsert",component=new{id=Text(state,"componentId"),title=Text(state,"label"),kind="markdown",data=new{text}}})));
                        if(Text(state,"callbackActionId").Length>0)
                        {
                            // Exact request identity prevents duplicate callbacks even after a scheduler interruption.
                            Invoke(runId,Json.Object(new{requestId="quick-text-callback-"+pending,actionId=Text(state,"callbackActionId"),definitionVersion=Text(config,"version"),input=new{context=new{eventType="quick-text-completed",sourceInvocationId=pending,cardId=runId,text}}}));
                        }
                        state["state"]="succeeded"; state["lastText"]=text; state["lastCompletedAt"]=Now; state["failures"]=0; state.Remove("error"); state.Remove("pendingInvocationId"); state["nextDueAt"]=Now+(long)(state["intervalSeconds"]!.GetValue<double>()*1000); SaveQuickText(state); continue;
                    }
                    if(Text(view,"status")!="active" || Now<state["nextDueAt"]!.GetValue<long>() || dispatched>=4) continue;
                    if(state["pendingRequest"] is not JsonObject request)
                    {
                        request=Json.Object(new{requestId="quick-text-"+Guid.NewGuid(),actionId=Text(state,"actionId"),definitionVersion=Text(config,"version"),input=new{context=TextContext(view)}});
                        // Persist the exact request before submitting. Invoke retries only return the same durable job.
                        state["pendingRequest"]=request.DeepClone(); SaveQuickText(state);
                    }
                    var invocation=Invoke(runId,request); state["pendingInvocationId"]=Text(invocation,"id"); state["dispatchedAt"]=Now; state["state"]="pending"; state.Remove("pendingRequest"); SaveQuickText(state); dispatched++;
                }
                catch(HubError error) { FailQuickText(state,error.Message); }
            }
        }
    }
}
