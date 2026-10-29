using System.Text.Json.Nodes;
using AgenticView.Server;
using Microsoft.Data.Sqlite;

internal static class ViewManagementContracts
{
    private static readonly Secrets Keys=new("synthetic-operator-viewer-key-at-least-32","synthetic-ingestion-key-at-least-32","synthetic-run-secret-at-least-32-characters");
    private const string Proof="synthetic-native-session-private-registration-proof";
    private static string S(JsonObject o,string key)=>o[key]!.GetValue<string>();
    private static void Check(bool ok,string message) { if(!ok) throw new Exception(message); }
    private static void Reject(Action action,int code) { try {action();} catch(HubError e) when(e.Status==code) {return;} throw new Exception("Expected error "+code); }
    private static JsonObject Registration(string request,bool native=false)=>Json.Object(new{requestId=request,registrationKey=Proof,agentId="native",name="Synthetic agent",sessionId=native?"native-session-123":"",sessionProvider=native?"synthetic":""});
    private static JsonObject Publish(Hub hub,JsonObject run,params object[] operations)=>hub.Publish(S(run,"runId"),S(run,"runToken"),Json.Object(new{sequence=hub.GetRun(S(run,"runId"))!["sequence"]!.GetValue<long>()+1,operations}));
    private static void Mutate(string path,string sql,string id)
    {
        using var db=new SqliteConnection("Data Source="+path);db.Open();using var command=db.CreateCommand();command.CommandText=sql;command.Parameters.AddWithValue("$id",id);command.ExecuteNonQuery();
    }
    public static void Run()
    {
        var root=Path.GetFullPath(Path.GetTempPath());var directory=Path.Combine(root,"agenticview-view-contract-"+Guid.NewGuid());
        try
        {
            NativeIdentity(directory); StablePacking(directory); ArchiveDelay(directory); OrphanInterruption(Path.Combine(directory,"orphan-interruption")); OperatorAndText(directory);
        }
        finally {SqliteConnection.ClearAllPools();if(Path.GetDirectoryName(Path.GetFullPath(directory))!=root.TrimEnd(Path.DirectorySeparatorChar))throw new Exception("Unsafe cleanup");if(Directory.Exists(directory))Directory.Delete(directory,true);}
    }
    private static void NativeIdentity(string directory)
    {
        using var hub=new Hub(directory,Keys);var one=hub.Register(Registration("native-one",true));var id=S(one,"runId");
        Publish(hub,one,new{op="upsert",component=new{id="plan",title="Plan",kind="markdown",data=new{text="- [ ] Retain context"}}});
        var layout=hub.GetRun(id)!["layout"]!.ToJsonString();hub.SetSessionStatus(id,S(one,"runToken"),"completed");
        var wrong=Registration("native-wrong",true);wrong["registrationKey"]=Proof+"-wrong";Reject(()=>hub.Register(wrong),409);
        var two=hub.Register(Registration("native-two",true));Check(S(two,"runId")==id && S(two,"runToken")==S(one,"runToken"),"Native registration created another card or token");
        Check(hub.GetRun(id)!["layout"]!.ToJsonString()==layout && S(hub.GetRun(id)!,"status")=="active","Continuation moved or failed to activate existing card");
        Publish(hub,two,new{op="context",text="Continued in same native session"});hub.Archive(id);hub.Dispose();
        using var reopened=new Hub(directory,Keys);var three=reopened.Register(Registration("native-three",true));Check(S(three,"runId")==id && reopened.GetRun(id)!["components"]!["plan"] is not null,"Restart/archive lost native identity or components");
        reopened.Archive(id);reopened.Restore(id);Check(reopened.GetRun(id) is not null,"Multiple registration aliases broke restore");
    }
    private static void StablePacking(string directory)
    {
        using var hub=new Hub(directory,Keys);hub.Flush();var first=hub.Register(Registration("packed-first"));hub.Flush();var id=S(first,"runId");var before=hub.GetRun(id)!["layout"]!.ToJsonString();
        var next=hub.Register(Registration("packed-next"));hub.Flush();hub.Archive(S(next,"runId"));hub.Flush();
        Check(hub.GetRun(id)!["layout"]!.ToJsonString()==before,"Arrival/archive moved established packed card");
        var layout=hub.GetRun(id)!["layout"]!.AsObject().DeepClone().AsObject();layout["height"]=2400;layout["sizing"]="content";layout["resolveOverlap"]=true;hub.SetLayout(id,layout);var grown=hub.GetRun(id)!["layout"]!.ToJsonString();hub.Flush();Check(hub.GetRun(id)!["layout"]!.ToJsonString()==grown,"Automatic packing moved resized existing card");
        layout["sizing"]="fixed";Reject(()=>hub.SetLayout(id,layout),400);
    }
    private static void ArchiveDelay(string directory)
    {
        string id;
        using(var hub=new Hub(directory,Keys))
        {
            var completed=hub.Register(Registration("delayed"));id=S(completed,"runId");hub.MakeApplication(id,S(completed,"runToken"),Json.Object(new{name="Session"}));hub.MarkManagedSession(id,S(completed,"runToken"),"session-1");hub.SetSessionStatus(id,S(completed,"runToken"),"completed");hub.Tick();Check(hub.GetRun(id) is not null,"Completion archived immediately");
        }
        Mutate(Path.Combine(directory,"agenticview.sqlite"),"UPDATE runs SET payload=json_set(payload,'$.completedAt',1,'$.lastSeen',9999999999999) WHERE id=$id",id);
        using(var hub=new Hub(directory,Keys)){hub.Tick();Check(hub.GetRun(id) is null,"Completed managed session ignored completion-based delay");hub.Restore(id);hub.Tick();Check(hub.GetRun(id) is not null,"Restored review card immediately rearchived");hub.SetSettings(Json.Object(new{autoArchiveMinutes=(int?)null,archiveAfterCompletion=true}));hub.Tick();Check(hub.GetRun(id) is not null,"Disabled archive delay failed");}
    }
    private static void OperatorAndText(string directory)
    {
        var config=new RuntimeConfig(directory,"127.0.0.1",0,new Uri("http://127.0.0.1"),Keys,directory);
        using var hub=new Hub(directory,Keys);using var controls=new ControlStore(config,hub);var view=new OperatorView(hub,controls,config);var run=hub.Register(Registration("text-owner"));var id=S(run,"runId");var token=S(run,"runToken");
        foreach(var denied in new[]{Keys.IngestToken,token,""})Reject(()=>view.Read(denied,"cards",null,0,25),403);
        Check(view.Read(Keys.ViewerToken,"cards",null,0,1)["cards"]!.AsArray().Count==1,"Operator page not bounded");Reject(()=>view.Read(Keys.ViewerToken,"cards",null,0,101),400);
        Check(view.Read(Keys.ViewerToken,"cards",null,0,100)["cards"]!.AsArray().OfType<JsonObject>().All(card=>!card.ContainsKey("taskTimes") && !card.ContainsKey("components") && !card.ContainsKey("application")),"Card summaries included unbounded component/timing/application payloads");
        var orphanInput=Json.Object(new{requestId="standalone",registrationKey=Proof,component=new{id="standalone",title="Standalone metric",kind="metric",data=new{value=42}}});
        var orphan=view.Configure(Keys.ViewerToken,"orphan",orphanInput);var retried=view.Configure(Keys.ViewerToken,"orphan",orphanInput);Check(S(orphan,"id")==S(retried,"id") && S(orphan,"orphanComponentId")=="standalone","Standalone component was duplicated or wrapped as agent");
        Reject(()=>view.Configure(Keys.ViewerToken,"publish",Json.Object(new{cardId=S(orphan,"id"),batch=new{sequence=2,operations=new[]{new{op="upsert",component=new{id="hidden",title="Must not hide",kind="metric",data=new{value=1}}}}}})),400);
        var actions=new JsonArray(Json.Object(new{id="generate",label="Read-only text generator",kind="prompt",target="agent",fields=new[]{new{key="context",label="Card context",type="json",required=true}}}));controls.Configure(id,token,Json.Object(new{actions}));
        var settings=Json.Object(new{actionId="generate",target="title",intervalSeconds=15,timeoutSeconds=5});Reject(()=>controls.ConfigureQuickText(id,"wrong","title",settings),403);
        var invalid=Json.Object(new{actionId="generate",intervalSeconds=1});Reject(()=>controls.ConfigureQuickText(id,token,"fast",invalid),400);
        controls.ConfigureQuickText(id,token,"title",settings);controls.TickQuickText();controls.TickQuickText();var jobs=controls.Poll(id,token,true);Check(jobs.Count==1,"Quick-text request missing or duplicated");var job=jobs[0]!.AsObject();Check(!Json.Text(job["input"]!).Contains(token),"Quick-text context leaked a run credential");
        controls.Complete(id,token,true,Json.Object(new{invocationId=S(job,"id"),claimToken=S(job,"claimToken"),state="succeeded",result=new{text="Bounded generated title"}}));controls.TickQuickText();Check(S(hub.GetRun(id)!,"name")=="Bounded generated title","Quick-text result not applied");
        controls.ConfigureQuickText(id,token,"title",Json.Object(new{enabled=false}));controls.ConfigureQuickText(id,token,"title",settings);controls.TickQuickText();var late=controls.Poll(id,token,true)[0]!.AsObject();
        controls.ConfigureQuickText(id,token,"title",Json.Object(new{enabled=false}));controls.Complete(id,token,true,Json.Object(new{invocationId=S(late,"id"),claimToken=S(late,"claimToken"),state="succeeded",result=new{text="Must be ignored"}}));controls.TickQuickText();Check(S(hub.GetRun(id)!,"name")=="Bounded generated title","Cancelled text result mutated the card");
        controls.ConfigureQuickText(id,token,"title",settings);controls.TickQuickText();controls.Poll(id,token,true);
        Mutate(Path.Combine(directory,"controls.sqlite"),"UPDATE quick_text SET payload=json_set(payload,'$.dispatchedAt',1) WHERE run_id=$id",id);controls.TickQuickText();var stopped=controls.QuickTextSettings(id,token)["configurations"]![0]!.AsObject();Check(!stopped["enabled"]!.GetValue<bool>() && S(stopped,"state")=="unknown","Uncertain claimed timeout was automatically replayable");
        // Settle the deliberately unknown claimed job, then simulate interruption after durable Invoke but before scheduler checkpoint.
        using(var db=new SqliteConnection("Data Source="+Path.Combine(directory,"controls.sqlite"))) {db.Open();using var c=db.CreateCommand();c.CommandText="UPDATE invocations SET state='cancelled',payload=json_set(payload,'$.state','cancelled') WHERE run_id=$id AND state='unknown'";c.Parameters.AddWithValue("$id",id);c.ExecuteNonQuery();}
        controls.ConfigureQuickText(id,token,"title",settings);controls.TickQuickText();
        Mutate(Path.Combine(directory,"controls.sqlite"),"UPDATE quick_text SET payload=json_remove(json_set(payload,'$.pendingRequest',json_object('requestId',(SELECT request_id FROM invocations WHERE run_id=$id AND state='queued' ORDER BY created DESC LIMIT 1))),'$.pendingInvocationId') WHERE run_id=$id",id);
        controls.ConfigureQuickText(id,token,"title",Json.Object(new{enabled=false}));Check(controls.Poll(id,token,true).Count==0,"Interrupted quick-text request survived cancellation");
        controls.ConfigureSessionLauncher(id,token,"session","Synthetic session","synthetic-worker","native",null,null,null);
        var draft=controls.DraftSession(Json.Object(new{requestId="operator-session-draft",launcherRunId=id,actionId="session"}));
        Reject(()=>view.Configure(Keys.ViewerToken,"session",Json.Object(new{cardId=id,sessionId=S(draft,"id"),control=new{requestId="wrong-session",operation="stop"}})),409);
        Check(S(view.Read(Keys.ViewerToken,"session",S(draft,"runId"),0,25),"id")==S(draft,"id"),"Operator session read did not resolve the card's session");
    }
    private static void OrphanInterruption(string directory)
    {
        var input=Json.Object(new{requestId="partial-orphan",registrationKey=Proof,component=new{id="component",title="Same title",kind="metric",data=new{value=1}}});string id;
        using(var hub=new Hub(directory,Keys)) id=S(hub.Orphan(input),"id");
        Mutate(Path.Combine(directory,"agenticview.sqlite"),"UPDATE runs SET payload=json_remove(payload,'$.orphanComponentId') WHERE id=$id",id);
        input["component"]!["data"]!["value"]=2;
        using var reopened=new Hub(directory,Keys);Reject(()=>reopened.Orphan(input),409);
    }
}
