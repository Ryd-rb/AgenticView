using System.Text.Json.Nodes;

namespace AgenticView.Server;

public sealed partial class ControlStore
{
    private JsonObject BackgroundError(HubError error,string? debugId=null){var result=EasyError(error,debugId);result["recovery"]="Use ui_guide goal test for background-test prerequisites. A fresh authenticated native desktop must advertise the card. Keep the explicit operator key private; never substitute ingestion or run credentials. Close a prior lease and wait for native stop acknowledgment before reuse.";result["nextCall"]=EasyCall("ui_guide",new{goal="test"});return result;}
    private static void DebugValidateBackgroundPoll(JsonObject input)
    {
        if(input.ContainsKey("backgroundTesting"))ComponentValidator.Boolean(input,"backgroundTesting");
        if(!input.ContainsKey("background"))return;
        var ack=ComponentValidator.Object(input["background"]);ComponentConfiguration.Keys(ack,"state","sessionId","error");
        ComponentValidator.Choice(ack,"state",["inactive","active","failed"]);
        if(ack.ContainsKey("sessionId")&&!Guid.TryParseExact(ComponentValidator.Text(ack,"sessionId",36,true,36),"D",out _))throw new HubError(400,"Background sessionId must be a UUID.");
        if(Text(ack,"state")=="active"&&!ack.ContainsKey("sessionId"))throw new HubError(400,"Active background acknowledgment requires sessionId.");
        if(ack.ContainsKey("error"))ComponentValidator.Text(ack,"error",200,true);
    }
    private void DebugBackgroundAck(string clientId,JsonObject input)
    {
        if(input["background"] is not JsonObject ack)return;
        var candidates=DebugRows("SELECT payload FROM debug_sessions WHERE client_id=$p0",clientId).Where(s=>s["background"] is JsonObject).ToArray();
        var sessionId=Text(ack,"sessionId");
        var session=sessionId.Length>0?candidates.FirstOrDefault(s=>Text(s,"id")==sessionId):candidates.Where(s=>Text(s,"state")=="open"||Text((s["backgroundAck"] as JsonObject)??new(),"state")!="inactive").SingleOrDefault();
        if(sessionId.Length>0&&session is null)throw new HubError(403,"Background acknowledgment belongs to another client or unavailable session.");
        if(session is null)return;
        session["backgroundAck"]=Json.Object(new{state=Text(ack,"state"),sessionId=Text(session,"id"),error=ack["error"]?.DeepClone(),at=Now});DebugSaveSession(session);
        if(Text(ack,"state")=="failed"){session["backgroundFailure"]=ack.DeepClone();DebugSaveSession(session);DebugCloseSession(session,"Native background testing failed.");}
    }
    private static bool DebugCanClaim(JsonObject session,bool visible)
        =>session["background"] is JsonObject?session["backgroundAck"] is JsonObject ack&&Text(ack,"state")=="active":visible;
    private static JsonObject DebugPollSession(JsonObject session)
    {
        var result=Json.Object(new{id=Text(session,"id"),runId=Text(session,"runId"),expiresAt=session["expiresAt"]!.GetValue<long>()});
        if(session["background"] is JsonObject background)result["background"]=background.DeepClone();return result;
    }
    public async Task<JsonObject> UiTestOpen(string operatorToken,string cardId,int durationSeconds=300,int width=1920,int height=1080,string? componentId=null,string? clientId=null)
    {
        try{
            if(!Authentication.Equal(operatorToken,secrets.ViewerToken))throw new HubError(403,"Explicit operator/viewer authority is required for background testing.");
            hub.OwnedToken(cardId);var config=Json.Object(new{durationSeconds,width,height});ComponentValidator.Number(config,"durationSeconds",1,7200,true,true);ComponentValidator.Number(config,"width",320,4096,true,true);ComponentValidator.Number(config,"height",240,4096,true,true);
            if(componentId is not null)ComponentValidator.Id(Json.Object(new{componentId}),"componentId");
            if(clientId is not null)DebugClientId(Json.Object(new{clientId}));
            string capability,commandId;
            lock(gate){
                DebugSweep();
                var client=DebugRows("SELECT payload FROM debug_clients").Where(c=>(clientId is null||Text(c,"id")==clientId)&&c["lastSeen"]!.GetValue<long>()>=Now-120000&&Text(c,"platform")=="desktop"&&c["backgroundTesting"]?.GetValue<bool>()==true&&((JsonArray)c["cardIds"]!).Any(id=>id!.GetValue<string>()==cardId)).OrderByDescending(c=>c["lastSeen"]!.GetValue<long>()).FirstOrDefault()??throw new HubError(409,"No fresh capable desktop client advertises this card. Native background testing support is required; browser clients cannot opt in.");
                var id=Text(client,"id");var previous=DebugRows("SELECT payload FROM debug_sessions WHERE client_id=$p0",id).Where(s=>s["background"] is JsonObject).ToArray();
                var session=previous.FirstOrDefault(s=>Text(s,"state")=="open");
                if(session is not null){
                    if(session["expiresAt"]!.GetValue<long>()-session["createdAt"]!.GetValue<long>()!=durationSeconds*1000L||Text(session,"runId")!=cardId||session["background"]!["width"]!.GetValue<int>()!=width||session["background"]!["height"]!.GetValue<int>()!=height||Text((JsonObject)session["easy"]!,"componentId")!=(componentId??""))throw new HubError(409,"This client already has a background lease. Close it and wait for native inactive acknowledgment before opening another.");
                    capability=EasyCapability(Text(session,"id"));return UiTestStatus(capability);
                }
                if(previous.Any(s=>Text((s["backgroundAck"] as JsonObject)??new(),"state")!="inactive"))throw new HubError(409,"Previous background lease is stopping; native inactive acknowledgment is required before reuse.");
                if(Convert.ToInt64(Scalar("SELECT COUNT(*) FROM debug_sessions"))>=DebugSessionCap)throw new HubError(409,"Debug session history cap reached; retry identities retained.");
                var requestId="background-"+Guid.NewGuid();session=Json.Object(new{id=Guid.NewGuid().ToString(),runId=cardId,clientId=id,requestId,state="open",createdAt=Now,expiresAt=Now+durationSeconds*1000L,background=new{width,height},easy=new{componentId=componentId??"",nextActionId=Guid.NewGuid().ToString(),targets=new JsonArray()}});
                Execute("INSERT INTO debug_sessions VALUES($p0,$p1,$p2,$p3,$p4,$p5)",Text(session,"id"),cardId,id,requestId,Hash(Canonical(config)),Json.Text(session));
                capability=EasyCapability(Text(session,"id"));var job=EasyQueue(session,"open-"+Guid.NewGuid(),Json.Object(new{operation="navigate",mode="maximize"}));job["easyThenInspect"]=true;DebugSaveCommand(job);commandId=Text(job,"id");
            }
            var response=await UiWait(capability,commandId);response["backgroundStatus"]=UiTestStatus(capability);return response;
        }catch(HubError error){return BackgroundError(error);}
    }
    public JsonObject UiTestStatus(string debugId)
    {
        try{lock(gate){
            var session=EasySession(debugId);if(session["background"] is not JsonObject config)throw new HubError(400,"This is an ordinary debugging lease, not a background test.");
            var ack=session["backgroundAck"] as JsonObject;var state=Text(ack??new(),"state");
            var status=session["backgroundFailure"] is JsonObject||state=="failed"?"failed":Text(session,"state")=="open"?state=="active"?"running":"starting":state=="inactive"?"stopped":"stopping";
            var easy=(JsonObject)session["easy"]!;var nextId=Text(easy,"nextActionId");
            return Json.Object(new{debugId,state=status,expiresAt=session["expiresAt"]!.GetValue<long>(),background=config.DeepClone(),lastNativeAck=ack?.DeepClone(),nativeFailure=session["backgroundFailure"]?.DeepClone(),stopAcknowledged=state=="inactive",physicalVisible=DebugClient(Text(session,"clientId"))["visible"]!.GetValue<bool>(),targets=easy["targets"]!.DeepClone(),nextActionId=nextId,reason=session["reason"]?.DeepClone(),nextCall=status=="running"?EasyCall("ui_inspect",new{debugId}):EasyCall("ui_test_status",new{debugId}),metricsScope="Offscreen/emulated rendering; not physical display/compositor presentation."});
        }}catch(HubError error){return BackgroundError(error,debugId);}
    }
}
