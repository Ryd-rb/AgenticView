using System.IO.Pipes;
using System.Text;

namespace AgenticView.Server;

/// <summary>One-process password delivery through a same-user named pipe, never argv or environment.</summary>
public sealed class SshAskpass : IAsyncDisposable
{
    private readonly string name="agenticview-ssh-"+Guid.NewGuid().ToString("N"), proof=Guid.NewGuid().ToString("N");
    private readonly CancellationTokenSource stop=new();
    private readonly Task server;
    public SshAskpass(System.Diagnostics.ProcessStartInfo start,string password)
    {
        var helper=Path.Combine(AppContext.BaseDirectory,OperatingSystem.IsWindows()?"AgenticView.Server.exe":"AgenticView.Server");
        if(!File.Exists(helper)) throw new InvalidDataException("SSH password authentication requires the packaged AgenticView apphost helper.");
        start.Environment["SSH_ASKPASS"]=helper; start.Environment["SSH_ASKPASS_REQUIRE"]="force"; start.Environment["DISPLAY"]="agenticview:0";
        start.Environment["AV_SSH_ASKPASS_PIPE"]=name; start.Environment["AV_SSH_ASKPASS_PROOF"]=proof;
        server=Serve(password);
    }
    private async Task Serve(string password)
    {
        try {
            for(var attempt=0;attempt<2 && !stop.IsCancellationRequested;attempt++) {
                await using var pipe=new NamedPipeServerStream(name,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous|PipeOptions.CurrentUserOnly);
                await pipe.WaitForConnectionAsync(stop.Token); using var reader=new StreamReader(pipe,Encoding.UTF8,false,1024,true); await using var writer=new StreamWriter(pipe,new UTF8Encoding(false),1024,true) { AutoFlush=true };
                using var deadline=CancellationTokenSource.CreateLinkedTokenSource(stop.Token); deadline.CancelAfter(TimeSpan.FromSeconds(5));
                var buffer=new char[proof.Length]; var read=0; while(read<buffer.Length) { var count=await reader.ReadAsync(buffer.AsMemory(read),deadline.Token); if(count==0) break; read+=count; }
                if(Authentication.Equal(new string(buffer),proof)) await writer.WriteLineAsync(password.AsMemory(),deadline.Token);
            }
        } catch(OperationCanceledException) { } catch(IOException) { }
    }
    public static async Task<int> Reply(string prompt)
    {
        if(!prompt.Contains("password",StringComparison.OrdinalIgnoreCase)) return 1;
        var name=Environment.GetEnvironmentVariable("AV_SSH_ASKPASS_PIPE")??""; var proof=Environment.GetEnvironmentVariable("AV_SSH_ASKPASS_PROOF")??"";
        if(!name.StartsWith("agenticview-ssh-",StringComparison.Ordinal) || proof.Length!=32) return 1;
        try { using var deadline=new CancellationTokenSource(TimeSpan.FromSeconds(10)); await using var pipe=new NamedPipeClientStream(".",name,PipeDirection.InOut,PipeOptions.Asynchronous|PipeOptions.CurrentUserOnly); await pipe.ConnectAsync(deadline.Token); await using var writer=new StreamWriter(pipe,new UTF8Encoding(false),1024,true) { AutoFlush=true }; using var reader=new StreamReader(pipe,Encoding.UTF8,false,1024,true); await writer.WriteAsync(proof.AsMemory(),deadline.Token); await writer.FlushAsync(deadline.Token); var password=await reader.ReadLineAsync(deadline.Token); if(password is null || password.Length>8192) return 1; await Console.Out.WriteLineAsync(password); return 0; }
        catch(Exception e) when(e is IOException or OperationCanceledException or UnauthorizedAccessException) { return 1; }
    }
    public async ValueTask DisposeAsync() { stop.Cancel(); await server; stop.Dispose(); }
}
