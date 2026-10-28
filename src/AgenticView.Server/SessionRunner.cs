using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using System.Runtime.InteropServices;

namespace AgenticView.Server;

/// <summary>Connector-owned, bounded concurrent agent processes. No shell interpolation.</summary>
public sealed class SessionRunner(HttpClient client,string connectorId,string connectorToken,JsonObject profiles) : IAsyncDisposable
{
    private readonly string owner=Guid.NewGuid().ToString();
    private readonly ConcurrentDictionary<string,Active> active=new();
    private long lastLease=Environment.TickCount64;
    private sealed class Active(JsonObject job) { public JsonObject Job=job; public readonly CancellationTokenSource Stop=new(); public readonly ConcurrentQueue<JsonObject> Reports=new(); public readonly SemaphoreSlim ReportGate=new(1,1); public Func<CancellationToken,Task>? Retry; public Task Task=Task.CompletedTask; }
    public async Task Run(CancellationToken cancellation)
    {
        try {
            while(!cancellation.IsCancellationRequested) {
                try {
                    await Task.WhenAll(active.Values.Where(a=>a.Task.IsCompleted && a.Retry is not null && !a.Reports.IsEmpty).Select(async a=>{try {using var deadline=CancellationTokenSource.CreateLinkedTokenSource(cancellation);deadline.CancelAfter(TimeSpan.FromSeconds(3));await a.Retry!(deadline.Token);}catch(Exception e)when(e is HttpRequestException or OperationCanceledException){ }}));
                    var jobs=(await Post($"/api/connectors/{connectorId}/sessions/poll",new JsonObject { ["owner"]=owner },cancellation)).AsArray(); lastLease=Environment.TickCount64;
                    var present=new HashSet<string>();
                    foreach(var node in jobs) {
                        var job=node!.AsObject(); var id=Json.String(job,"id"); present.Add(id);
                        if(active.TryGetValue(id,out var old)) { if(old.Task.IsCompleted) { if(Json.String(old.Job,"claimToken")==Json.String(job,"claimToken") && old.Job["generation"]!.GetValue<int>()==job["generation"]!.GetValue<int>()) continue; active.TryRemove(id,out _); old.Stop.Dispose(); old.ReportGate.Dispose(); } else { if(old.Job["generation"]!.GetValue<int>()!=job["generation"]!.GetValue<int>() || Json.String(job,"desiredState")!="running") old.Stop.Cancel(); continue; } }
                        if(Json.String(job,"desiredState")!="running") continue;
                        var item=new Active(job); if(!active.TryAdd(id,item)) continue;
                        item.Task=Execute(item,cancellation);
                    }
                    foreach(var pair in active) if(!present.Contains(pair.Key)) { pair.Value.Stop.Cancel(); if(pair.Value.Task.IsCompleted && pair.Value.Reports.IsEmpty && active.TryRemove(pair.Key,out var done)) { done.Stop.Dispose(); done.ReportGate.Dispose(); } }
                } catch(Exception e) when(!cancellation.IsCancellationRequested && e is HttpRequestException or TaskCanceledException) { if(Environment.TickCount64-lastLease>15000) foreach(var item in active.Values) item.Stop.Cancel(); }
                await Task.Delay(1000,cancellation);
            }
        } catch(OperationCanceledException) when(cancellation.IsCancellationRequested) { }
        finally { foreach(var item in active.Values) item.Stop.Cancel(); await Task.WhenAll(active.Values.Select(a=>a.Task)); }
    }
    private async Task<JsonNode> Post(string path,JsonObject body,CancellationToken cancellation)
    {
        using var request=new HttpRequestMessage(HttpMethod.Post,path); request.Headers.Authorization=new("Bearer",connectorToken); request.Content=new StringContent(Json.Text(body),Encoding.UTF8,"application/json");
        using var response=await client.SendAsync(request,cancellation); response.EnsureSuccessStatusCode(); return JsonNode.Parse(await response.Content.ReadAsStringAsync(cancellation))!;
    }
    private async Task Execute(Active item,CancellationToken shutdown)
    {
        var job=item.Job; var id=Json.String(job,"id"); var generation=job["generation"]!.GetValue<int>(); var queue=new ConcurrentQueue<JsonObject>(); long retained=0; string? native=null; var provider="custom"; var failed=false; var outcome="failed"; var password=""; var sshAuthenticationRejected=false;var sshAuthenticated=false;
        using var stop=CancellationTokenSource.CreateLinkedTokenSource(item.Stop.Token,shutdown); var cancellation=stop.Token;
        async Task Flush(CancellationToken cancel) {
            await item.ReportGate.WaitAsync(cancel);
            try {
                while(item.Reports.TryPeek(out var report)) {
                    using var deadline=CancellationTokenSource.CreateLinkedTokenSource(cancel);deadline.CancelAfter(TimeSpan.FromSeconds(5));
                    await Post($"/api/connectors/{connectorId}/sessions/{id}/report",report,deadline.Token);item.Reports.TryDequeue(out _);
                }
            } finally {item.ReportGate.Release();}
        }
        item.Retry=Flush;
        async Task Report(string? finish=null) {
                var entries=new JsonArray(); var size=0;
                while(entries.Count<50 && size<196608 && queue.TryDequeue(out var entry)) { var count=Encoding.UTF8.GetByteCount(Json.Text(entry)); Interlocked.Add(ref retained,-count); size+=count; entries.Add(entry); }
                var report=Json.Object(new{owner,claimToken=Json.String(job,"claimToken"),generation,reportId=Guid.NewGuid().ToString(),entries});
                if(native is not null) report["nativeSessionId"]=native; if(finish is not null) report["outcome"]=finish;
                report["agentType"]=provider; report["transport"]=Json.String(profiles[Json.String(job,"handler")] as JsonObject ?? new JsonObject(),"transport")=="ssh"?"ssh":"local";
                item.Reports.Enqueue(report);
                for(var attempt=0;attempt<3;attempt++) { try { await Flush(CancellationToken.None); break; } catch(Exception e) when(attempt<2 && e is HttpRequestException or TaskCanceledException) { await Task.Delay(250); } }
        }
        void Enqueue(JsonObject entry) {
            var text=Json.String(entry,"text");
            foreach(var key in new[]{password,connectorToken,Json.String(job,"reportingToken"),Environment.GetEnvironmentVariable("AV_INGEST_KEY")??""}) if(key.Length>0 && (key==password || key.Length>=16)) text=text.Replace(key,"[credential redacted]",StringComparison.Ordinal);
            entry["text"]=text; var count=Encoding.UTF8.GetByteCount(Json.Text(entry)); queue.Enqueue(entry); Interlocked.Add(ref retained,count);
            while(Interlocked.Read(ref retained)>524288 && queue.TryDequeue(out var removed)) Interlocked.Add(ref retained,-Encoding.UTF8.GetByteCount(Json.Text(removed)));
        }
        try {
            var profile=profiles[Json.String(job,"handler")] is JsonObject configured ? (JsonObject)configured.DeepClone() : throw new InvalidDataException("Session profile unavailable.");
            if(Json.String(profile,"type")!="agent-session") throw new InvalidDataException("Handler must be an agent-session profile.");
            provider=ComponentValidator.Text(profile,"provider",40); if(!new[]{"codex","claude","opencode","custom"}.Contains(provider)) throw new InvalidDataException("Unsupported session provider.");
            var prompt=Json.String(job,"prompt"); var instructions=Instructions(job);
            if(Json.String(job,"recoveryMode")=="handoff") { var handoff=job["handoff"]?.ToJsonString()??"{}"; if(handoff.Length>262144) handoff=handoff[..262144]+" [handoff truncated]"; prompt="Replacement session. Reuse this card and its existing components. Prior monitoring export:\n"+handoff+"\n\n"+prompt; }
            prompt=instructions+"\n\nUser task:\n"+prompt;
            var nativeId=Json.String(job,"nativeSessionId"); var resume=Json.String(job,"recoveryMode")=="native" && nativeId.Length>0;
            JsonObject? credential=null;
            if(Json.String(profile,"transport")=="ssh") {
                var connection=job["connection"] as JsonObject; var machineId=connection is not null?Json.String(connection,"machineId"):Json.String(profile,"machineId");
                if(machineId.Length>0) {
                    var dynamic=ComponentValidator.Boolean(profile,"allowConfiguredMachines");
                    if(!dynamic && machineId!=Json.String(profile,"machineId")) throw new InvalidDataException("This session profile does not allow configured machines.");
                    try { credential=(await Post($"/api/connectors/{connectorId}/ssh/{Uri.EscapeDataString(machineId)}/acquire",dynamic?new JsonObject():Json.Object(new{host=Json.String(profile,"sshHost"),port=profile["sshPort"]?.GetValue<int>()??22}),cancellation)).AsObject(); }
                    catch(HttpRequestException e) when(e.StatusCode is System.Net.HttpStatusCode.Conflict or System.Net.HttpStatusCode.Forbidden) { outcome="auth-required"; throw new InvalidDataException("SSH credential binding requires configuration."); }
                    if(profile["allowedHosts"] is JsonArray allowed && !allowed.Any(h=>string.Equals(h?.GetValue<string>(),Json.String(credential,"host"),StringComparison.OrdinalIgnoreCase))) throw new InvalidDataException("SSH host is outside the connector allowlist.");
                    password=Json.String(credential,"password"); profile["sshHost"]=credential["host"]!.DeepClone(); profile["sshPort"]=credential["port"]!.DeepClone(); if(Json.String(credential,"username").Length>0) profile["sshUsername"]=credential["username"]!.DeepClone(); profile["credentialEnabled"]=password.Length>0;
                    if(connection is not null && Json.String(connection,"remoteProfileId").Length>0) { var key=Json.String(connection,"remoteProfileId"); var selected=profile["remoteProfiles"]?[key]; if(selected is JsonObject recipe) { ComponentValidator.Choice(recipe,"provider",["codex","claude","opencode","custom"]); provider=Json.String(recipe,"provider"); profile["provider"]=provider; selected=recipe["command"]; } profile["remoteCommand"]=(selected as JsonArray ?? throw new InvalidDataException("Remote agent profile is outside the local allowlist.")).DeepClone(); }
                }
            }
            var start=BuildStart(profile,prompt,resume?nativeId:null);
            foreach(var key in start.Environment.Keys.Where(k=>k.StartsWith("AV_",StringComparison.OrdinalIgnoreCase)).ToArray()) start.Environment.Remove(key);
            var reportingUrl=profile.ContainsKey("reportingUrl")?ComponentValidator.Text(profile,"reportingUrl",2048):client.BaseAddress!.GetLeftPart(UriPartial.Authority);
            if(!Uri.TryCreate(reportingUrl,UriKind.Absolute,out var reportUri) || reportUri.Scheme is not ("http" or "https") || reportUri.UserInfo.Length>0) throw new InvalidDataException("Reporting URL must be an HTTP(S) origin.");
            start.Environment["AV_URL"]=reportingUrl; start.Environment["AV_SESSION_ID"]=id; start.Environment["AV_RUN_ID"]=Json.String(job,"runId"); start.Environment["AV_SESSION_TOKEN"]=Json.String(job,"reportingToken");
            await using var passwordBridge=password.Length>0?new SshAskpass(start,password):null;
            Enqueue(Json.Object(new{stream="system",format="text",text=resume?"Resuming the existing provider session.":Json.String(job,"recoveryMode")=="handoff"?"Monitoring export retained. Starting a replacement provider session in this card.":"Starting a new agent session.",level="info",label="Lifecycle"}));
            await Report();
            using var process=new Process { StartInfo=start }; process.Start(); using var containment=SessionJob.Attach(process);
            using var killOnStop=cancellation.Register(()=>{try { if(!process.HasExited) process.Kill(entireProcessTree:true); } catch(InvalidOperationException) { } catch(System.ComponentModel.Win32Exception) { } });
            using var heartbeatStop=CancellationTokenSource.CreateLinkedTokenSource(cancellation); Task heartbeat=Task.CompletedTask;
            var lastOutput=Environment.TickCount64;
            async Task Drain(StreamReader reader,string stream) {
                var buffer=new char[4096]; var line=new StringBuilder(); int count;
                while((count=await reader.ReadAsync(buffer,CancellationToken.None))>0) {
                    Interlocked.Exchange(ref lastOutput,Environment.TickCount64);
                    for(var i=0;i<count;i++) { var c=buffer[i]; if(c=='\n' || line.Length>=32768) { Emit(line.ToString().TrimEnd('\r'),stream); line.Clear(); } if(c!='\n') line.Append(c); }
                }
                if(line.Length>0) Emit(line.ToString(),stream);
            }
            void Emit(string line,string stream) { if(line.Length==0) return; if(stream=="stdout" && line.Trim()=="{\"agenticviewSshAuthenticated\":true}"){sshAuthenticated=true;return;} if(stream=="stderr" && (line.Contains(": Permission denied (",StringComparison.OrdinalIgnoreCase) || line.StartsWith("Permission denied",StringComparison.OrdinalIgnoreCase) || line.Contains("Too many authentication failures",StringComparison.OrdinalIgnoreCase))) sshAuthenticationRejected=true; var parsed=SessionOutput.Parse(provider,line,stream); if(parsed.NativeId is not null) native=parsed.NativeId; if(parsed.Error) failed=true; if(parsed.Entry is not null) Enqueue(parsed.Entry); }
            var stdout=Drain(process.StandardOutput,"stdout"); var stderr=Drain(process.StandardError,"stderr");
            var input=Json.String(profile,"promptTransport");
            try {
                if(Json.String(profile,"transport")=="ssh") {
                    var environment=new JsonObject { ["AV_URL"]=reportingUrl,["AV_SESSION_ID"]=id,["AV_RUN_ID"]=Json.String(job,"runId"),["AV_SESSION_TOKEN"]=Json.String(job,"reportingToken") };
                    await process.StandardInput.WriteLineAsync(Json.Text(Json.Object(new{prompt,nativeSessionId=resume?nativeId:null,environment})).AsMemory(),cancellation); await process.StandardInput.FlushAsync(cancellation);
                    heartbeat=Task.Run(async()=>{try { while(!heartbeatStop.IsCancellationRequested) { await Task.Delay(5000,heartbeatStop.Token); await process.StandardInput.WriteLineAsync("{\"heartbeat\":true}".AsMemory(),heartbeatStop.Token); await process.StandardInput.FlushAsync(heartbeatStop.Token); } } catch(OperationCanceledException) { } catch(IOException) { } catch(ObjectDisposedException) { } });
                } else { if(input!="argument") await process.StandardInput.WriteAsync(prompt.AsMemory(),cancellation); process.StandardInput.Close(); }
            }
            catch(IOException) { /* Provider may reject startup before reading stdin. Its exit status remains authoritative. */ }
            var stallSeconds=profile.ContainsKey("silenceTimeoutSeconds")?ComponentValidator.Number(profile,"silenceTimeoutSeconds",0,86400,true,true):0;
            var runtimeSeconds=profile.ContainsKey("maxTurnSeconds")?ComponentValidator.Number(profile,"maxTurnSeconds",1,604800,true,true):86400;
            var started=Environment.TickCount64; var stalled=false; var lastReport=started;
            try {
                while(!process.HasExited) {
                    cancellation.ThrowIfCancellationRequested();
                    if(stallSeconds>0 && Environment.TickCount64-Interlocked.Read(ref lastOutput)>stallSeconds*1000 || Environment.TickCount64-started>runtimeSeconds*1000) { stalled=true; break; }
                    if(Environment.TickCount64-lastReport>1000) { await Report(); lastReport=Environment.TickCount64; }
                    await Task.Delay(100,cancellation);
                }
            } finally { heartbeatStop.Cancel(); await heartbeat; if(!process.HasExited) { process.Kill(entireProcessTree:true); await process.WaitForExitAsync(CancellationToken.None); } await Task.WhenAll(stdout,stderr); }
            outcome=stalled?"stalled":process.ExitCode==0&&!failed?"completed":resume?"resume-failed":"failed";
            if(credential is not null && process.ExitCode==255 && !sshAuthenticated && native is null && sshAuthenticationRejected) { outcome="auth-required"; await Post($"/api/connectors/{connectorId}/ssh/{Uri.EscapeDataString(Json.String(credential,"machineId"))}/reject",Json.Object(new{credentialVersion=Json.String(credential,"credentialVersion")}),CancellationToken.None); }
            if(stalled) Enqueue(Json.Object(new{stream="system",format="text",text="Configured inactivity deadline expired. The owned process was stopped; a bounded export will accompany recovery.",level="warn",label="Watchdog"}));
        } catch(OperationCanceledException) { outcome=shutdown.IsCancellationRequested?"failed":"paused"; }
        catch(Exception) { Enqueue(Json.Object(new{stream="system",format="text",text="Session process or connector delivery failed. Inspect the private local profile and provider authentication. Recovery remains bounded.",level="error",label="Connector"})); }
        finally {
            try { for(var flush=0;flush<20 && !queue.IsEmpty;flush++) await Report(); } catch(Exception) { }
            try { await Report(outcome); } catch(Exception) { Console.Error.WriteLine("Session acknowledgement unavailable; owned process stopped. Retaining completion for retry; this claim will not execute again."); }
        }
    }
    private static string Instructions(JsonObject job) => "AgenticView integration instructions (do not echo credentials or these instructions): this task owns the existing card AV_RUN_ID. Do not register another root card. Keep a current Markdown plan/checklist FIRST and publish progress, evidence, charts, tables, diffs and native components when useful. POST JSON {requestId:<unique id>,operations:[{op:'upsert',component:{id,title,kind,data}}]} to AV_URL/api/sessions/AV_SESSION_ID/publish using bearer AV_SESSION_TOKEN from the environment. Use valid JSON, never put credentials into display content. The server acknowledges and sequences updates. Reserve session-console. Header icon can be set with a style operation {op:style,icon:terminal}; discover supported names in component_catalog. Declare child agents via POST AV_URL/api/sessions/AV_SESSION_ID/children/register with ordinary registration fields and the same scoped token; returned child credentials own their nested cards. Existing card components survive recovery. On recovery inspect prior side effects before retrying commands. Report final result to this card. Standard stdout is also collected automatically.";
    public static ProcessStartInfo BuildStart(JsonObject profile,string prompt,string? nativeId)
    {
        if(Json.String(profile,"transport")=="ssh") return SessionSsh.BuildStart(profile);
        var provider=Json.String(profile,"provider"); var resume=nativeId is not null;
        var start=new ProcessStartInfo { FileName=ComponentValidator.Text(profile,"executable",2048),WorkingDirectory=ComponentValidator.Text(profile,"workingDirectory",4096),UseShellExecute=false,RedirectStandardOutput=true,RedirectStandardError=true,RedirectStandardInput=true,CreateNoWindow=true };
        if(!Directory.Exists(start.WorkingDirectory)) throw new InvalidDataException("Session working directory unavailable.");
        var program=Path.GetFileNameWithoutExtension(start.FileName).ToLowerInvariant(); if(program is "cmd" or "powershell" or "pwsh" or "sh" or "bash") throw new InvalidDataException("Use a CLI executable or fixed adapter executable, never a shell command profile.");
        var prefix=(profile["prefixArguments"] as JsonArray ?? new JsonArray()).Select(n=>n!.GetValue<string>()).ToArray();
        foreach(var argument in prefix) start.ArgumentList.Add(argument);
        string[] args=provider switch {
            "codex"=>resume?["exec","resume",nativeId!,"--json","-"]:["exec","--json","-"],
            "claude"=>resume?["-p","--resume",nativeId!,"--output-format","stream-json","--verbose"]:["-p","--output-format","stream-json","--verbose"],
            "opencode"=>resume?["run","--session",nativeId!,"--format","json"]:["run","--format","json"],
            "custom"=>(profile[resume?"resumeArguments":"arguments"] as JsonArray ?? throw new InvalidDataException("Custom profile requires explicit start/resume arguments.")).Select(n=>n!.GetValue<string>()).ToArray(),
            _=>throw new InvalidDataException("Unsupported provider.") };
        // Extra arguments are fixed in the local trusted profile and inserted before the stdin prompt marker.
        var extra=(profile["extraArguments"] as JsonArray ?? new JsonArray()).Select(n=>n!.GetValue<string>()).ToArray();
        foreach(var arg in args.Take(args.LastOrDefault()=="-"?args.Length-1:args.Length)) start.ArgumentList.Add(arg=="{sessionId}"?nativeId??"":arg=="{prompt}"?prompt:arg);
        foreach(var arg in extra) start.ArgumentList.Add(arg);
        foreach(var arg in (profile[resume?"extraResumeArguments":"extraStartArguments"] as JsonArray ?? new JsonArray()).Select(n=>n!.GetValue<string>())) start.ArgumentList.Add(arg);
        if(args.LastOrDefault()=="-") start.ArgumentList.Add("-");
        if(Json.String(profile,"promptTransport")=="argument" && provider!="custom") start.ArgumentList.Add(prompt);
        if(profile["environment"] is JsonObject environment) foreach(var p in environment) start.Environment[p.Key]=p.Value?.GetValue<string>();
        if(program is "node" or "python" or "python3" or "ruby" or "perl") {
            var all=start.ArgumentList.ToArray();
            if(all.Length==0 || all[0].StartsWith('-') || all[0].Contains('{') || !File.Exists(all[0])) throw new InvalidDataException("Interpreter sessions require a fixed local adapter file; eval/source flags are forbidden.");
            if(all.Any(a=>a is "-e" or "--eval" or "-c" && provider=="custom")) throw new InvalidDataException("Executable source flags are forbidden in custom adapters.");
        }
        return start;
    }
    public async ValueTask DisposeAsync() { foreach(var item in active.Values) item.Stop.Cancel(); await Task.WhenAll(active.Values.Select(a=>a.Task)); foreach(var item in active.Values) { item.Stop.Dispose(); item.ReportGate.Dispose(); } }
}

/// <summary>Close the connector's owned child tree if Windows terminates the connector.</summary>
internal sealed class SessionJob : IDisposable
{
    private IntPtr handle;
    public static SessionJob Attach(Process process) {
        var job=new SessionJob(); if(!OperatingSystem.IsWindows()) return job;
        job.handle=CreateJobObject(IntPtr.Zero,null); if(job.handle==IntPtr.Zero) throw new InvalidOperationException("Cannot contain session process.");
        var info=new ExtendedLimit { Basic=new BasicLimit { LimitFlags=0x2000 } }; var size=Marshal.SizeOf<ExtendedLimit>(); var pointer=Marshal.AllocHGlobal(size);
        try { Marshal.StructureToPtr(info,pointer,false); if(!SetInformationJobObject(job.handle,9,pointer,(uint)size) || !AssignProcessToJobObject(job.handle,process.Handle)) { job.Dispose(); if(!process.HasExited) process.Kill(true); throw new InvalidOperationException("Cannot contain session process."); } }
        finally { Marshal.FreeHGlobal(pointer); }
        return job;
    }
    public void Dispose() { if(handle!=IntPtr.Zero) { CloseHandle(handle); handle=IntPtr.Zero; } }
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimit { public long PerProcessUserTimeLimit,PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass,SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimit { public BasicLimit Basic; public IoCounters Io; public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed; }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] private static extern IntPtr CreateJobObject(IntPtr security,string? name);
    [DllImport("kernel32.dll")] private static extern bool SetInformationJobObject(IntPtr job,int info,IntPtr value,uint length);
    [DllImport("kernel32.dll")] private static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
}
