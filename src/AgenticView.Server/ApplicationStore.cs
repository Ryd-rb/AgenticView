using System.Text.Json.Nodes;

namespace AgenticView.Server;

public sealed partial class ControlStore
{
    private static void Keys(JsonObject value,params string[] allowed)
    {
        if(value.Any(p=>!allowed.Contains(p.Key,StringComparer.Ordinal))) throw new HubError(400,"Portable definitions contain unsupported or installation-specific fields.");
    }
    public static JsonObject ValidateApplication(JsonObject raw)
    {
        Budget(raw,262144); var manifest=Clone(raw);
        Keys(manifest,"schemaVersion","id","version","name","description","permanent","bindings","actions","components","layout","icon");
        if(manifest.ContainsKey("icon")) CardStyles.Validate(manifest);
        if(ComponentValidator.Number(manifest,"schemaVersion",1,1,true,true)!=1 || !ComponentValidator.Boolean(manifest,"permanent")) throw new HubError(400,"A version 1 application definition must be permanent.");
        ComponentValidator.Id(manifest,"id"); ComponentValidator.Text(manifest,"version",80,true,1); ComponentValidator.Text(manifest,"name",160,true,1); ComponentValidator.Text(manifest,"description",2000,false);
        var bindings=new HashSet<string>();
        foreach(var node in ComponentValidator.Array(manifest,"bindings",64)) {
            var binding=ComponentValidator.Object(node); Keys(binding,"id","label","description"); var id=ComponentValidator.Id(binding,"id");
            if(id=="agent" || !bindings.Add(id)) throw new HubError(400,"Binding IDs must be unique; agent is reserved.");
            ComponentValidator.Text(binding,"label",160,true,1); ComponentValidator.Text(binding,"description",2000,false);
        }
        var actions=ComponentValidator.Array(manifest,"actions",64);
        foreach(var node in actions) {
            var action=ComponentValidator.Object(node); Keys(action,"id","label","kind","target","handler","description","confirmation","fields","connection");
            var target=ComponentValidator.Id(action,"target"); if(target!="agent" && !bindings.Contains(target)) throw new HubError(400,"Actions must target an agent inbox or a declared logical binding.");
            if(action["connection"] is JsonObject connection && !bindings.Contains(ComponentValidator.Id(connection,"machineId"))) throw new HubError(400,"Portable SSH launchers use a declared logical machine binding.");
            if(action["fields"] is JsonArray fields) foreach(var item in fields) Keys(ComponentValidator.Object(item),"key","label","type","required","options","min","max");
        }
        ValidateActions(actions);
        var actionKinds=actions.OfType<JsonObject>().ToDictionary(a=>Json.String(a,"id"),a=>Json.String(a,"kind"));
        void Reference(string id,string? kind=null) { if(!actionKinds.TryGetValue(id,out var value) || kind is not null && value!=kind) throw new HubError(400,"A component references an unavailable or incompatible action."); }
        var componentIds=new HashSet<string>();
        foreach(var node in ComponentValidator.Array(manifest,"components",64)) {
            var component=ComponentValidator.Object(node); ComponentValidator.Validate(component); if(!componentIds.Add(Json.String(component,"id"))) throw new HubError(400,"Application component IDs must be unique.");
            var data=component["data"]!.AsObject();
            switch(Json.String(component,"kind")) {
                case "action-panel": foreach(var id in data["actionIds"]!.AsArray()) Reference(id!.GetValue<string>()); break;
                case "log-stream": Reference(Json.String(data,"actionId"),"logs"); break;
                case "session-launcher": Reference(Json.String(data,"actionId"),"session"); break;
                case "agent-session": throw new HubError(400,"Portable definitions use session-launcher; managed session IDs are installation state.");
                case "table": if(data["sourceAction"] is not null) Reference(Json.String(data,"sourceAction"),"query"); break;
                case "data-grid": foreach(var key in new[]{"readAction","editAction","addAction","deleteAction","bulkAction","historyAction"}) if(data[key] is not null) Reference(Json.String(data,key),key=="readAction"?"query":key=="historyAction"?"history":"edit"); break;
            }
        }
        if(manifest["layout"] is not null) {
            var layout=ComponentValidator.Object(manifest["layout"]); Keys(layout,"width","height","sizing"); ComponentValidator.Number(layout,"width",320,1600); ComponentValidator.Number(layout,"height",240,1600); ComponentValidator.Choice(layout,"sizing",["content","fixed"]);
        }
        Budget(manifest,262144); // Defaults must not produce an export that cannot be imported again.
        return manifest;
    }
    public JsonObject DefineApplication(string id,string token,JsonObject raw)
    {
        hub.VerifyRun(id,token); var manifest=ValidateApplication(raw);
        hub.MakeApplication(id,token,ApplicationMetadata(manifest));
        if(manifest.ContainsKey("icon")) hub.SetCardStyle(id,token,new JsonObject{["icon"]=manifest["icon"]!.DeepClone()});
        lock(gate) { Execute("INSERT INTO application_definitions VALUES($p0,$p1) ON CONFLICT(run_id) DO UPDATE SET payload=excluded.payload",id,Json.Text(manifest)); }
        return Clone(manifest);
    }
    private static JsonObject ApplicationMetadata(JsonObject manifest) => new() { ["id"]=manifest["id"]!.DeepClone(),["name"]=manifest["name"]!.DeepClone(),["version"]=manifest["version"]!.DeepClone(),["description"]=manifest["description"]?.DeepClone()??JsonValue.Create("") };
    public JsonObject ExportApplication(string id)
    {
        lock(gate) return Scalar("SELECT payload FROM application_definitions WHERE run_id=$p0",id) is string value?Parse(value):throw new HubError(404,"No authored portable definition is saved for this card. Define one before exporting.");
    }
    public JsonArray Applications(int offset=0,int limit=25)
    {
        lock(gate) {
            var result=new JsonArray(); using var command=Command("SELECT run_id,payload FROM application_definitions ORDER BY rowid DESC LIMIT $p0 OFFSET $p1",Math.Clamp(limit,1,25),Math.Clamp(offset,0,1000000)); using var reader=command.ExecuteReader();
            while(reader.Read()) { var manifest=Parse(reader.GetString(1)); var item=ApplicationMetadata(manifest); item["runId"]=reader.GetString(0); item["components"]=manifest["components"]!.AsArray().Count; item["actions"]=manifest["actions"]!.AsArray().Count; result.Add(item); }
            return result;
        }
    }
    public JsonObject ImportApplication(JsonObject input)
    {
        Budget(input,524288); Keys(input,"manifest","bindings","requestId","registrationKey");
        var request=ComponentValidator.Id(input,"requestId"); if(request.Length>80) throw new HubError(400,"Application import request IDs are limited to 80 characters.");
        var proof=ComponentValidator.Text(input,"registrationKey",256,true,32);
        var manifest=ValidateApplication(ComponentValidator.Object(input["manifest"])); var bindings=ComponentValidator.Object(input["bindings"]);
        var declared=manifest["bindings"]!.AsArray().OfType<JsonObject>().Select(b=>Json.String(b,"id")).ToHashSet();
        if(bindings.Any(p=>!declared.Contains(p.Key)) || declared.Any(id=>!bindings.ContainsKey(id))) throw new HubError(400,"Supply exactly the declared logical connector bindings.");
        foreach(var key in declared) if(ComponentValidator.Id(bindings,key)=="agent") throw new HubError(400,"A connector binding cannot use the reserved agent inbox target.");
        var actions=(JsonArray)manifest["actions"]!.DeepClone();
        foreach(var action in actions.OfType<JsonObject>()) { if(Json.String(action,"target")!="agent") action["target"]=bindings[Json.String(action,"target")]!.DeepClone(); if(action["connection"] is JsonObject connection) connection["machineId"]=bindings[Json.String(connection,"machineId")]!.DeepClone(); }
        var configuration=new JsonObject { ["actions"]=actions,["application"]=ApplicationMetadata(manifest) }; Budget(configuration,131072); ValidateActions(actions);
        var digest=Hash(Canonical(input));
        lock(gate) {
            using(var command=Command("SELECT digest FROM application_imports WHERE request_id=$p0",request)) if(command.ExecuteScalar() is string existing && !Authentication.Equal(existing,digest)) throw new HubError(409,"This application import request ID already has different content or proof.");
            // Hub registration supplies the same private run token after an exact retry.
            var registered=hub.Register(Json.Object(new{requestId="application:"+request,registrationKey=proof,agentId="application:"+digest[..48],name=Json.String(manifest,"name"),role="Application",context=Json.String(manifest,"description")}));
            var id=Json.String(registered,"runId"); var token=Json.String(registered,"runToken");
            var complete=Convert.ToInt64(Scalar("SELECT complete FROM application_imports WHERE request_id=$p0",request)??0L)!=0;
            if(!complete) {
                Execute("INSERT INTO application_imports VALUES($p0,$p1,$p2,0) ON CONFLICT(request_id) DO NOTHING",request,digest,id);
                Configure(id,token,configuration);
                var operations=new JsonArray(manifest["components"]!.AsArray().Select(c=>(JsonNode)new JsonObject{["op"]="upsert",["component"]=c!.DeepClone()}).ToArray());
                if(operations.Count==0) operations.Add(new JsonObject{["op"]="context",["text"]=manifest["description"]?.DeepClone()??JsonValue.Create("")});
                hub.Publish(id,token,new JsonObject{["sequence"]=1,["operations"]=operations});
                if(manifest["layout"] is JsonObject layout) hub.SetApplicationSize(id,token,layout);
                DefineApplication(id,token,manifest);
                Execute("UPDATE application_imports SET complete=1 WHERE request_id=$p0",request);
            }
            registered["sequence"]=hub.GetRun(id)?["sequence"]?.DeepClone()??registered["sequence"]?.DeepClone();
            registered["application"]=ApplicationMetadata(manifest);
            return registered;
        }
    }
}
