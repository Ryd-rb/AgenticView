using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace AgenticView.Desktop;

// Low-rate native control polling survives renderer visibility/timer throttling.
internal sealed class DesktopDebugChannel : IDisposable
{
    private readonly NativeWebView view;
    private readonly DesktopOptions options;
    private readonly Func<bool> trusted,physicalVisible;
    private readonly long hostDeadline;
    private readonly Uri origin;
    private readonly CookieContainer cookies=new();
    private readonly HttpClient client;
    private readonly System.Windows.Forms.Timer timer=new(){Interval=250};
    private readonly SemaphoreSlim modeGate=new(1,1);
    private readonly CancellationTokenSource lifetime=new();
    private NativeDebugRegistration? registration;
    private JsonObject acknowledgment=new(){["state"]="inactive"};
    private string? activeSession;
    private long activeUntil,nextPoll;
    private int generation;
    private bool busy,disposed,unavailable;
    private Task resetTask=Task.CompletedTask;
    private Task pollTask=Task.CompletedTask;
    private static long Now=>DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    public DesktopDebugChannel(NativeWebView view,DesktopOptions options,Func<bool> trusted,Func<bool> physicalVisible,long hostDeadline)
    {
        this.view=view;this.options=options;this.trusted=trusted;this.physicalVisible=physicalVisible;this.hostDeadline=hostDeadline;origin=new(options.Url.GetLeftPart(UriPartial.Authority));
        client=new(new HttpClientHandler{CookieContainer=cookies,AllowAutoRedirect=false,UseProxy=false}){Timeout=TimeSpan.FromSeconds(5)};client.DefaultRequestHeaders.TryAddWithoutValidation("Origin",origin.AbsoluteUri.TrimEnd('/'));
        timer.Tick+=async(_,_)=>{try{
            if(activeSession is not null&&Now>=activeUntil)await SetBackground(null);
            if(disposed||!pollTask.IsCompleted)return;
            pollTask=Tick();await pollTask;
        }catch{if(!disposed)nextPoll=Now+2000;}};timer.Start();
    }
    public void Register(NativeDebugRegistration value)
    {
        if(disposed)return;if(registration is{} old&&old.ClientId!=value.ClientId)Reset();if(registration?.ClientId!=value.ClientId){generation++;nextPoll=0;}registration=value;
    }
    public void Disconnect(string id){if(registration?.ClientId==id)Reset();}
    public void Reset()
    {
        var previous=registration;registration=null;generation++;nextPoll=0;
        resetTask=ResetAsync(previous,resetTask);
    }
    private async Task ResetAsync(NativeDebugRegistration? previous,Task priorReset)
    {
        try{
            // Drain the prior request before the terminal acknowledgment. A delayed
            // active poll must never overwrite inactive readiness after disconnect.
            try{await priorReset;await pollTask;}catch{}
            await SetBackground(null);
            if(previous is not null){
                using var stopped=await client.PostAsJsonAsync(new Uri(origin,"/api/debug/poll"),new{clientId=previous.ClientId,clientToken=previous.ClientToken,cardIds=Array.Empty<string>(),visible=physicalVisible(),platform="desktop",backgroundTesting=false,background=acknowledgment.DeepClone()},lifetime.Token);
                using var response=await client.PostAsJsonAsync(new Uri(origin,"/api/debug/disconnect"),new{clientId=previous.ClientId,clientToken=previous.ClientToken},lifetime.Token);
            }
        }catch{}finally{acknowledgment=new JsonObject{["state"]="inactive"};foreach(Cookie cookie in cookies.GetCookies(origin))cookie.Expired=true;}
    }
    private async Task Tick()
    {
        if(disposed)return;
        // Expiry runs independently of renderer timers and outstanding HTTP requests.
        if(activeSession is not null&&Now>=activeUntil)await SetBackground(null);
        if(busy||!resetTask.IsCompleted||registration is not{} identity||Now<nextPoll||!view.Ready||!trusted())return;
        busy=true;var version=generation;
        try{
            var browserCookies=await view.CoreWebView2.CookieManager.GetCookiesAsync(options.Url.AbsoluteUri);
            var session=browserCookies.FirstOrDefault(c=>c.Name=="av_session"&&c.IsHttpOnly);if(session is null){nextPoll=Now+5000;return;}
            cookies.Add(origin,new Cookie("av_session",session.Value,"/",origin.Host){HttpOnly=true,Secure=origin.Scheme=="https"});
            var body=new JsonObject{["clientId"]=identity.ClientId,["clientToken"]=identity.ClientToken,["cardIds"]=System.Text.Json.JsonSerializer.SerializeToNode(identity.CardIds),["visible"]=physicalVisible(),["platform"]="desktop",["backgroundTesting"]=!unavailable,["background"]=acknowledgment.DeepClone()};
            using var response=await client.PostAsJsonAsync(new Uri(origin,"/api/debug/poll"),body,lifetime.Token);
            if(!response.IsSuccessStatusCode){nextPoll=Now+2000;return;}
            var raw=await response.Content.ReadAsStringAsync(lifetime.Token);if(raw.Length>262144)throw new InvalidOperationException("Bounded native debug poll exceeded.");
            var result=JsonNode.Parse(raw)?.AsObject()??throw new InvalidOperationException();if(disposed||version!=generation||registration?.ClientId!=identity.ClientId)return;
            var background=(result["sessions"] as JsonArray)?.OfType<JsonObject>().FirstOrDefault(s=>s["background"] is JsonObject);
            await SetBackground(background);
            if(disposed||version!=generation||!trusted()||!view.Ready)return;
            view.CoreWebView2.PostWebMessageAsJson(new JsonObject{["type"]="agenticview:debug-poll",["clientId"]=identity.ClientId,["response"]=result}.ToJsonString());
            nextPoll=Now+(activeSession is null&&background is null?(result["pollMs"]?.GetValue<int>()??5000):250);
        }finally{busy=false;}
    }
    private async Task SetBackground(JsonObject? session)
    {
        await modeGate.WaitAsync();
        try{
            var id=session?["id"]?.GetValue<string>();var expires=session?["expiresAt"]?.GetValue<long>()??0;
            if(disposed||expires<=Now)id=null;
            if(id==activeSession&&(id is not null||acknowledgment["state"]?.GetValue<string>()=="inactive")){if(id is not null)activeUntil=Math.Min(activeUntil,expires);return;}
            var prior=activeSession??acknowledgment["sessionId"]?.GetValue<string>();
            if(activeSession is not null||id is null){
                activeSession=null;activeUntil=0;
                PostBackground(false,prior,0);
                try{if(view.Ready)await view.CoreWebView2.CallDevToolsProtocolMethodAsync("Emulation.setFocusEmulationEnabled","{\"enabled\":false}").WaitAsync(TimeSpan.FromSeconds(3));}
                catch{unavailable=true;view.CloseController();}
                finally{view.SetTestViewport(null);view.SetHostVisibility(physicalVisible());}
                acknowledgment=new JsonObject{["state"]="inactive"};if(prior is not null)acknowledgment["sessionId"]=prior;
            }
            if(id is null)return;
            try{
                if(!Guid.TryParseExact(id,"D",out _)||expires>Now+7_200_000||hostDeadline>0&&expires>hostDeadline)throw new InvalidOperationException();
                var config=session!["background"]!.AsObject();var width=config["width"]!.GetValue<int>();var height=config["height"]!.GetValue<int>();if(width is <320 or >4096||height is <240 or >4096)throw new InvalidOperationException();
                view.SetTestViewport(new Size(width,height));
                await view.CoreWebView2.CallDevToolsProtocolMethodAsync("Emulation.setFocusEmulationEnabled","{\"enabled\":true}").WaitAsync(TimeSpan.FromSeconds(3));
                if(disposed||expires<=Now)throw new InvalidOperationException();
                activeSession=id;activeUntil=expires;acknowledgment=new JsonObject{["state"]="active",["sessionId"]=id};PostBackground(true,id,expires);
                Console.WriteLine("{\"event\":\"desktop-background-test\",\"state\":\"active\"}");
            }catch{
                try{if(view.Ready)await view.CoreWebView2.CallDevToolsProtocolMethodAsync("Emulation.setFocusEmulationEnabled","{\"enabled\":false}").WaitAsync(TimeSpan.FromSeconds(3));}catch{unavailable=true;view.CloseController();}
                view.SetTestViewport(null);view.SetHostVisibility(physicalVisible());activeSession=null;activeUntil=0;
                acknowledgment=new JsonObject{["state"]="failed",["sessionId"]=id,["error"]="Native background rendering unavailable or requested lease exceeds test-host lifetime."};PostBackground(false,id,0);
                Console.WriteLine("{\"event\":\"desktop-background-test\",\"state\":\"failed\"}");
            }
        }finally{modeGate.Release();}
    }
    private void PostBackground(bool active,string? id,long expires)
    {
        if(view.Ready&&trusted())view.CoreWebView2.PostWebMessageAsJson(new JsonObject{["type"]="agenticview:debug-background",["active"]=active,["sessionId"]=id,["expiresAt"]=expires,["physicalVisible"]=physicalVisible()}.ToJsonString());
    }
    public void Dispose(){if(disposed)return;disposed=true;timer.Stop();timer.Dispose();registration=null;generation++;lifetime.Cancel();client.Dispose();lifetime.Dispose();}
}
