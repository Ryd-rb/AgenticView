using System.Text.Json;
using System.Text.Json.Nodes;
using AgenticView.Server;

static class SnapshotSerializationContracts
{
    public static void Run()
    {
        var directory=Path.Combine(Path.GetTempPath(),"agenticview-snapshot-contract-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var secrets=new Secrets("synthetic-snapshot-viewer","synthetic-snapshot-ingest","synthetic-snapshot-run");
            using var hub=new Hub(directory,secrets);
            var run=hub.Register(Json.Object(new{requestId="snapshot",registrationKey="synthetic-snapshot-registration-proof",agentId="snapshot",name="Snapshot 日本語"}));
            var id=run["runId"]!.GetValue<string>(); var token=run["runToken"]!.GetValue<string>();
            var points=Enumerable.Range(0,1500).Select(i=>new{x=i,y=(i%37)-18}).ToArray();
            hub.Publish(id,token,Json.Object(new{sequence=1,operations=new object[]{
                new{op="upsert",component=new{id="chart",title="Synthetic curves",kind="chart",data=new{series=new[]{new{id="a",name="A",points},new{id="b",name="B",points}}}}},
                new{op="context",text="Literal \"quotes\", newline\n, 日本語 and \u2028"}
            }}));
            var expected=hub.Snapshot(); var owned=hub.SnapshotUtf8();
            Check(JsonNode.DeepEquals(expected,JsonNode.Parse(owned.Span)),"UTF8 snapshot changed the public snapshot contract");
            hub.Publish(id,token,Json.Object(new{sequence=2,operations=new[]{new{op="context",text="Later value"}}}));
            Check(JsonNode.DeepEquals(expected,JsonNode.Parse(owned.Span)),"A later mutation changed an already-owned snapshot buffer");
            Check(!JsonNode.DeepEquals(expected,hub.Snapshot()),"Snapshot fixture did not mutate");

            // Compare the full old clone+serialization path with the same output
            // captured directly. This tests work proportional to retained data,
            // without a machine-specific timing threshold or image acceptance.
            long Measure(Action action)
            {
                action();var before=GC.GetAllocatedBytesForCurrentThread();action();
                return GC.GetAllocatedBytesForCurrentThread()-before;
            }
            var copied=Measure(()=>{_ = JsonSerializer.SerializeToUtf8Bytes(hub.Snapshot());});
            var direct=Measure(()=>{_ = hub.SnapshotUtf8();});
            Check(direct*2<copied,$"Snapshot still duplicates the retained graph: direct={direct}, cloned={copied}");
            Parallel.For(0,8,_=>Check(JsonNode.DeepEquals(hub.Snapshot(),JsonNode.Parse(hub.SnapshotUtf8().Span)),"Concurrent snapshot readers disagreed"));
        }
        finally { Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools(); Directory.Delete(directory,true); }
    }
    private static void Check(bool value,string message){if(!value)throw new InvalidOperationException(message);}
}
