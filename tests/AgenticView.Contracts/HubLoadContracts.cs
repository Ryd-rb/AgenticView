using System.Text.Json.Nodes;
using AgenticView.Server;
using Microsoft.Data.Sqlite;

static class HubLoadContracts
{
    public static void Run()
    {
        var directory=Path.Combine(Path.GetTempPath(),"agenticview-load-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var secrets=new Secrets("synthetic-load-viewer","synthetic-load-ingest","synthetic-load-run");
            string id,token;
            using(var hub=new Hub(directory,secrets))
            {
                var registered=hub.Register(Json.Object(new{requestId="load",registrationKey="synthetic-load-registration-proof",agentId="load",name="Load"}));
                id=registered["runId"]!.GetValue<string>();token=registered["runToken"]!.GetValue<string>();
                hub.Publish(id,token,Json.Object(new{sequence=1,operations=new[]{new{op="upsert",component=new{id="meter",title="Meter",kind="progress",data=new{value=12}}}}}));
            }
            // A legacy stored component can require validation defaults on load.
            using(var db=new SqliteConnection("Data Source="+Path.Combine(directory,"agenticview.sqlite")))
            {
                db.Open();using var read=db.CreateCommand();read.CommandText="SELECT payload FROM components WHERE run_id=$id AND id='meter'";read.Parameters.AddWithValue("$id",id);
                var stored=JsonNode.Parse((string)read.ExecuteScalar()!)!.AsObject();stored["data"]!.AsObject().Remove("max");
                using var write=db.CreateCommand();write.CommandText="UPDATE components SET payload=$value WHERE run_id=$id AND id='meter'";write.Parameters.AddWithValue("$value",stored.ToJsonString());write.Parameters.AddWithValue("$id",id);write.ExecuteNonQuery();
            }
            using(var hub=new Hub(directory,secrets))
            {
                var before=hub.GetRun(id)!;
                Check(before["components"]!["meter"]!["data"]!["max"]!.GetValue<int>()==100,"Load lost normalized validation defaults");
                Check(JsonNode.DeepEquals(hub.Snapshot(),JsonNode.Parse(hub.SnapshotUtf8().Span)),"Loaded snapshot contracts differ");
                // Editing a compact loaded component still owns its new state.
                hub.Publish(id,token,Json.Object(new{sequence=2,operations=new[]{new{op="upsert",component=new{id="meter",title="Meter",kind="progress",data=new{value=23,max=200}}}}}));
                Check(before["components"]!["meter"]!["data"]!["value"]!.GetValue<int>()==12,"A loaded snapshot was mutated by publication");
                using var reopened=new Hub(directory,secrets);
                Check(JsonNode.DeepEquals(hub.GetRun(id),reopened.GetRun(id)),"Edited loaded state did not survive restart");
            }
        }
        finally {SqliteConnection.ClearAllPools();Directory.Delete(directory,true);}
    }
    private static void Check(bool value,string message){if(!value)throw new InvalidOperationException(message);}
}
