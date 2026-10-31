using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using AgenticView.Server;
using Microsoft.Data.Sqlite;

static class InvocationAllocationContracts
{
    public static JsonObject Probe(bool enforce)
    {
        var directory=Path.Combine(Path.GetTempPath(),"agenticview-invoke-probe-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try{
            var secrets=new Secrets("synthetic-viewer-proof-for-allocation","synthetic-ingest-proof-for-allocation","synthetic-run-proof-for-allocation");
            var config=new RuntimeConfig(directory,"127.0.0.1",0,new Uri("http://127.0.0.1"),secrets,directory);
            using var hub=new Hub(directory,secrets);using var controls=new ControlStore(config,hub);
            var run=hub.Register(Json.Object(new{requestId="allocation",registrationKey="synthetic-allocation-registration-proof",agentId="allocation",name="Synthetic allocation"}));
            var id=Text(run,"runId");var token=Text(run,"runToken");
            var definition=controls.Configure(id,token,Json.Object(new{actions=new object[]{
                new{id="read",label="Read",kind="query",target="agent"},
                new{id="edit",label="Edit",kind="edit",target="agent"},
                new{id="history",label="History",kind="history",target="agent"},
                new{id="evaluate",label="Evaluate",kind="query",target="agent"}
            }}));
            var version=Text(definition,"version");var serial=0;
            JsonObject Input(string action,object values,string? suppliedVersion=null)=>Json.Object(new{requestId="invocation-"+(++serial),actionId=action,definitionVersion=suppliedVersion??version,input=values});
            void Complete(JsonObject invocation){var job=controls.Poll(id,token,true).Single()!.AsObject();Check(Text(job,"id")==Text(invocation,"id"),"Claimed a different invocation");controls.Complete(id,token,true,Json.Object(new{invocationId=Text(job,"id"),claimToken=Text(job,"claimToken"),state="succeeded",result=new{}}));}
            JsonObject Measure(){
                var allocations=new List<long>();var elapsed=new List<double>();
                for(var i=0;i<10;i++){
                    var input=Input("read",new{limit=100});
                    var before=GC.GetAllocatedBytesForCurrentThread();var start=Stopwatch.GetTimestamp();
                    var invocation=controls.Invoke(id,input);
                    var ticks=Stopwatch.GetTimestamp()-start;var bytes=GC.GetAllocatedBytesForCurrentThread()-before;
                    Complete(invocation);
                    if(i>=2){allocations.Add(bytes);elapsed.Add(ticks*1000d/Stopwatch.Frequency);}
                }
                allocations.Sort();elapsed.Sort();
                return Json.Object(new{samples=allocations.Count,medianAllocatedBytes=allocations[allocations.Count/2],medianMilliseconds=elapsed[elapsed.Count/2],maxMilliseconds=elapsed[^1]});
            }
            var small=Measure();
            var points=Enumerable.Range(0,1500).Select(i=>new{x=i,y=(i%37)-18}).ToArray();
            var heavy=Json.Object(new{sequence=1,operations=new object[]{
                new{op="upsert",component=new{id="chart",title="Synthetic curves",kind="chart",data=new{series=new[]{new{id="a",name="A",points},new{id="b",name="B",points}}}}},
                new{op="upsert",component=new{id="grid",title="Synthetic records",kind="data-grid",data=new{
                    columns=new object[]{new{key="id",label="ID",type="number"},new{key="quantity",label="Quantity",type="number",constraints=new{type="integer",min=0,max=100,required=true}}},
                    rows=Enumerable.Range(0,1000).Select(i=>new{id=i,quantity=i%100}).ToArray(),editAction="edit",historyAction="history",evaluateAction="evaluate",features=new{edit=true,history=false,evaluate=false}
                }}}
            }});
            hub.Publish(id,token,heavy);var large=Measure();
            var snapshot=hub.GetRun(id)!.ToJsonString();
            Reject(()=>controls.Invoke(id,Input("edit",new{componentId="grid",operation="update",row=new{id=1,quantity=101}})),400);
            Reject(()=>controls.Invoke(id,Input("edit",new{componentId="wrong",operation="update",row=new{id=1,quantity=2}})),400);
            Reject(()=>controls.Invoke(id,Input("history",new{componentId="grid",rowId=1})),403);
            Reject(()=>controls.Invoke(id,Input("evaluate",new{componentId="grid"})),403);
            Reject(()=>controls.Invoke(id,Input("read",new{limit=100},"stale")),409);
            Reject(()=>controls.Invoke("missing",Input("read",new{limit=100})),404);
            var valid=Input("edit",new{componentId="grid",operation="update",row=new{id=1,quantity=2}});
            var accepted=controls.Invoke(id,valid);Check(Text(controls.Invoke(id,valid),"id")==Text(accepted,"id"),"Exact retry changed invocation");Complete(accepted);
            Check(hub.GetRun(id)!.ToJsonString()==snapshot,"Read-only grid validation mutated the card");
            hub.Archive(id);Reject(()=>controls.Invoke(id,Input("read",new{limit=100})),404);
            Check(Text(controls.Invoke(id,valid),"id")==Text(accepted,"id"),"Historical exact retry was not retained after archive");
            var connector=controls.RegisterConnector(Json.Object(new{id="probe-connector",name="Synthetic connector",registrationKey="synthetic-connector-registration-proof"}));
            var secondary=hub.Register(Json.Object(new{requestId="connector-probe",registrationKey="synthetic-allocation-registration-proof",agentId="connector-probe",name="Synthetic connector probe"}));
            var secondaryId=Text(secondary,"runId");var connectorToken=Text(connector,"token");
            var connectorDefinition=controls.Configure(secondaryId,Text(secondary,"runToken"),Json.Object(new{actions=new[]{new{id="read",label="Read",kind="query",target="probe-connector",handler="read"}}}));
            var pollTimes=new List<double>();var completeTimes=new List<double>();
            for(var i=0;i<70;i++){
                var invocation=controls.Invoke(secondaryId,Json.Object(new{requestId="connector-"+i,actionId="read",definitionVersion=Text(connectorDefinition,"version"),input=new{limit=100}}));
                var tick=Stopwatch.GetTimestamp();var job=controls.Poll("probe-connector",connectorToken,false).Single()!.AsObject();
                var pollMs=(Stopwatch.GetTimestamp()-tick)*1000d/Stopwatch.Frequency;
                Check(Text(job,"id")==Text(invocation,"id"),"Connector claimed a different job");
                if(i==0)Check(controls.Poll("probe-connector",connectorToken,false).Count==0,"Outstanding command was replayed");
                var completion=Json.Object(new{invocationId=Text(job,"id"),claimToken=Text(job,"claimToken"),state="succeeded",result=new{rows=Array.Empty<object>()}});
                if(i==0){var wrong=(JsonObject)completion.DeepClone();wrong["claimToken"]="wrong";Reject(()=>controls.Complete("probe-connector",connectorToken,false,wrong),403);}
                tick=Stopwatch.GetTimestamp();var completed=controls.Complete("probe-connector",connectorToken,false,completion);
                var completeMs=(Stopwatch.GetTimestamp()-tick)*1000d/Stopwatch.Frequency;
                if(i>=2){pollTimes.Add(pollMs);completeTimes.Add(completeMs);}
                if(i==0){Check(JsonNode.DeepEquals(completed,controls.Complete("probe-connector",connectorToken,false,completion)),"Exact completion retry changed result");var conflict=(JsonObject)completion.DeepClone();conflict["result"]=new JsonObject{["changed"]=true};Reject(()=>controls.Complete("probe-connector",connectorToken,false,conflict),409);}
            }
            Check(controls.History(secondaryId,100).Count==64,"Read result retention was not bounded at64");
            using(var inspection=new SqliteConnection("Data Source="+Path.Combine(directory,"controls.sqlite"))){
                inspection.Open();
                object? Sql(string sql){using var command=inspection.CreateCommand();command.CommandText=sql;return command.ExecuteScalar();}
                Check(Convert.ToInt64(Sql("PRAGMA synchronous"))==2,"Probe connection did not retain FULL durability");
                // Force the second write to fail and prove no earlier write leaks.
                var pending=controls.Invoke(secondaryId,Json.Object(new{requestId="rollback",actionId="read",definitionVersion=Text(connectorDefinition,"version"),input=new{limit=100}}));
                Sql("UPDATE connectors SET payload=json_set(payload,'$.lastSeen',42) WHERE id='probe-connector'");
                var connectorBefore=(string)Sql("SELECT payload FROM connectors WHERE id='probe-connector'")!;
                Sql("CREATE TRIGGER fail_claim BEFORE UPDATE ON invocations WHEN NEW.state='running' BEGIN SELECT RAISE(ABORT,'synthetic claim failure'); END");
                bool failed=false;try{controls.Poll("probe-connector",connectorToken,false);}catch(SqliteException){failed=true;}
                Check(failed,"Claim fault did not execute");
                Check((string)Sql("SELECT payload FROM connectors WHERE id='probe-connector'")! == connectorBefore,"Failed claim committed its heartbeat");
                Check(Text(controls.Invocation(secondaryId,Text(pending,"id")),"state")=="queued","Failed claim changed invocation state");
                Sql("DROP TRIGGER fail_claim");
                var claimJob=controls.Poll("probe-connector",connectorToken,false).Single()!.AsObject();
                var done=Json.Object(new{invocationId=Text(claimJob,"id"),claimToken=Text(claimJob,"claimToken"),state="succeeded",result=new{}});
                Sql("CREATE TRIGGER fail_retention BEFORE DELETE ON invocations BEGIN SELECT RAISE(ABORT,'synthetic retention failure'); END");
                failed=false;try{controls.Complete("probe-connector",connectorToken,false,done);}catch(SqliteException){failed=true;}
                Check(failed,"Retention fault did not execute");
                Check(Text(controls.Invocation(secondaryId,Text(pending,"id")),"state")=="running","Failed retention committed completion without its pruning");
                Sql("DROP TRIGGER fail_retention");
                Check(Text(controls.Complete("probe-connector",connectorToken,false,done),"state")=="succeeded","Rollback prevented acknowledgement retry");
                Check(controls.History(secondaryId,100).Count==64,"Atomic completion broke retained-window bound");
            }
            JsonObject Distribution(List<double> values){values.Sort();return Json.Object(new{samples=values.Count,p50Milliseconds=values[values.Count/2],p95Milliseconds=values[(int)Math.Ceiling(values.Count*.95)-1],maxMilliseconds=values[^1]});}
            var connectorTimings=new JsonObject{["poll"]=Distribution(pollTimes),["complete"]=Distribution(completeTimes)};
            var sweep=SweepProbe(controls,directory,secondaryId);
            var source=Path.GetFullPath("src/AgenticView.Server");
            string Hash(string path)=>Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(path)));
            var report=Json.Object(new{small,heavy=large,connectorTimings,sweep,syntheticChartPoints=3000,syntheticGridRows=1000,inputSha256=Convert.ToHexStringLower(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(heavy.ToJsonString()))),hubSourceSha256=Hash(Path.Combine(source,"Hub.cs")),controlSourceSha256=Hash(Path.Combine(source,"ControlStore.cs")),serverBinarySha256=Hash(typeof(Hub).Assembly.Location),scope="Synchronous actual ControlStore.Invoke allocation/timing; warmed8 calls per card size. Separate connector poll/complete timings cover68 warmed calls each, FULL/WAL unchanged. Sweep timing compares same synthetic private history before/after state index. Synthetic preparation excluded. Not HTTP or native UI throughput."});
            var evidence=Environment.GetEnvironmentVariable("AV_INVOKE_PROBE_EVIDENCE");
            if(!string.IsNullOrEmpty(evidence)){Directory.CreateDirectory(evidence);File.WriteAllText(Path.Combine(evidence,"input.json"),heavy.ToJsonString());File.WriteAllText(Path.Combine(evidence,"result.json"),report.ToJsonString());}
            if(enforce)Check(large["medianAllocatedBytes"]!.GetValue<long>()<=small["medianAllocatedBytes"]!.GetValue<long>()+262144,"Read invocation allocation scales with unrelated card data");
            return report;
        }finally{
            SqliteConnection.ClearAllPools();
            // Retain unknown paths/links; remove only this fixture's closed SQLite files.
            if((File.GetAttributes(directory)&FileAttributes.ReparsePoint)!=0||Path.GetDirectoryName(Path.GetFullPath(directory))!=Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath())))throw new IOException("Fixture cleanup boundary differs");
            var allowed=new HashSet<string>(StringComparer.Ordinal){"agenticview.sqlite","agenticview.sqlite-wal","agenticview.sqlite-shm","controls.sqlite","controls.sqlite-wal","controls.sqlite-shm"};
            var files=Directory.GetFileSystemEntries(directory);
            foreach(var file in files){var attributes=File.GetAttributes(file);if(!allowed.Contains(Path.GetFileName(file))||(attributes&(FileAttributes.Directory|FileAttributes.ReparsePoint))!=0)throw new IOException("Unknown fixture output retained");using var exclusive=File.Open(file,FileMode.Open,FileAccess.ReadWrite,FileShare.None);}
            foreach(var file in files)File.Delete(file);
            Directory.Delete(directory);
        }
    }
    private static JsonObject SweepProbe(ControlStore controls,string directory,string runId)
    {
        using var db=new SqliteConnection("Data Source="+Path.Combine(directory,"controls.sqlite"));db.Open();
        object? Sql(string text){using var command=db.CreateCommand();command.CommandText=text;return command.ExecuteScalar();}
        Check(Sql("SELECT name FROM sqlite_master WHERE type='index' AND name='invocations_by_state'") is string,"Constructor did not create state-leading index");
        // Only synthetic completed commands are added; no credentials or live database is copied.
        using(var transaction=db.BeginTransaction()){
            using var insert=db.CreateCommand();insert.Transaction=transaction;
            insert.CommandText="INSERT INTO invocations VALUES($id,'synthetic-history',$id,'synthetic','connector:unused','succeeded',0,$payload)";
            var idParameter=insert.Parameters.Add("$id",SqliteType.Text);var payload=insert.Parameters.Add("$payload",SqliteType.Text);
            var content=new string('s',4096);
            for(var i=0;i<4096;i++){var id="history-"+i;idParameter.Value=id;payload.Value=Json.Object(new{id,runId="synthetic-history",kind="command",state="succeeded",createdAt=0,result=new{synthetic=content}}).ToJsonString();insert.ExecuteNonQuery();}
            transaction.Commit();
        }
        const string select="SELECT payload FROM invocations WHERE state IN ('queued','running')";
        JsonArray Plan(){var result=new JsonArray();using var c=db.CreateCommand();c.CommandText="EXPLAIN QUERY PLAN "+select;using var reader=c.ExecuteReader();while(reader.Read())result.Add(reader.GetString(3));return result;}
        JsonArray Times(){var result=new JsonArray();for(var i=0;i<8;i++){using var c=db.CreateCommand();c.CommandText=select;var tick=Stopwatch.GetTimestamp();using(var reader=c.ExecuteReader())Check(!reader.Read(),"Expected empty active set");result.Add((Stopwatch.GetTimestamp()-tick)*1000d/Stopwatch.Frequency);}return result;}
        var beforeCount=Convert.ToInt64(Sql("SELECT count(*) FROM invocations"));
        Check(Convert.ToInt64(Sql("SELECT count(*) FROM invocations WHERE state IN ('queued','running')"))==0,"History fixture unexpectedly active");
        Sql("DROP INDEX invocations_by_state");var beforePlan=Plan();var beforeTimes=Times();
        Sql("CREATE INDEX invocations_by_state ON invocations(state)");var afterPlan=Plan();var afterTimes=Times();
        Check(afterPlan.Any(node=>node!.GetValue<string>().Contains("SEARCH invocations USING INDEX invocations_by_state",StringComparison.Ordinal)),"Active sweep does not SEARCH its state-leading index");
        Check(!afterPlan.Any(node=>node!.GetValue<string>().Contains("SCAN invocations",StringComparison.Ordinal)),"Active sweep still scans completed history");
        var now=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        foreach(var item in new[]{("expired-queued","queued",0L), ("expired-running","running",0L), ("fresh-queued","queued",now), ("fresh-running","running",now)}){
            using var c=db.CreateCommand();c.CommandText="INSERT INTO invocations VALUES($id,$run,$id,'synthetic','connector:expiry',$state,$created,$payload)";
            c.Parameters.AddWithValue("$id",item.Item1);c.Parameters.AddWithValue("$run",runId);c.Parameters.AddWithValue("$state",item.Item2);c.Parameters.AddWithValue("$created",item.Item3);
            c.Parameters.AddWithValue("$payload",Json.Object(new{id=item.Item1,runId,kind="command",state=item.Item2,createdAt=item.Item3,startedAt=item.Item3}).ToJsonString());c.ExecuteNonQuery();
        }
        Check(Text(controls.Invocation(runId,"expired-queued"),"state")=="cancelled","Expired queued job did not cancel");
        Check(Text(controls.Invocation(runId,"expired-running"),"state")=="unknown","Expired running job did not become unknown");
        Check(Text(controls.Invocation(runId,"fresh-queued"),"state")=="queued"&&Text(controls.Invocation(runId,"fresh-running"),"state")=="running","Index changed unexpired active jobs");
        Check(Convert.ToInt64(Sql("SELECT count(*) FROM invocations WHERE state IN ('queued','running')"))==2,"Active job count differs after expiry");
        Check(Convert.ToInt64(Sql("SELECT count(*) FROM invocations"))==beforeCount+4&&Convert.ToInt64(Sql("SELECT count(*) FROM invocations WHERE run_id='synthetic-history'"))==4096,"Sweep removed retained completed history");
        return new JsonObject{["syntheticCompletedHistoryRows"]=4096,["emptyActiveRows"]=0,["beforePlan"]=beforePlan,["afterPlan"]=afterPlan,["beforeMilliseconds"]=beforeTimes,["afterMilliseconds"]=afterTimes,["activeAfterExpiry"]=2,["queuedExpiry"]="cancelled",["runningExpiry"]="unknown"};
    }
    private static string Text(JsonObject obj,string key)=>obj[key]!.GetValue<string>();
    private static void Check(bool valid,string message){if(!valid)throw new Exception(message);}
    private static void Reject(Action action,int status){try{action();}catch(HubError error)when(error.Status==status){return;}throw new Exception("Expected HubError "+status);}
}
