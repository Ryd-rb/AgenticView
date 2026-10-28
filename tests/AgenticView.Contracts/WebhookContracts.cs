using System.Net;
using System.Text.Json.Nodes;
using AgenticView.Server;

static class WebhookContracts
{
    public static void AcknowledgementSurvivesBodyCancellation()
    {
        using var cancellation=new CancellationTokenSource(); using var receiver=new Receiver(cancellation); using var client=new HttpClient(receiver);
        var profile=Json.Object(new{url="http://127.0.0.1/hook",maxAttempts=3,idempotent=true});
        var job=Json.Object(new{id="synthetic-known-ack",runId="synthetic-run",actionId="prompt",kind="prompt",input=new{message="Synthetic"},createdAt=1L});
        var result=WebhookHandler.Deliver(profile,job,cancellation.Token,client).GetAwaiter().GetResult();
        if(result["delivery"]?["state"]?.GetValue<string>()!="acknowledged" || result["responseUnavailable"]?.GetValue<bool>()!=true || receiver.Calls!=1) throw new Exception("Known 2xx delivery was lost or replayed during parent cancellation.");
    }
    private sealed class Receiver(CancellationTokenSource cancellation):HttpMessageHandler
    {
        public int Calls;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token) { Calls++; return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Accepted){Content=new StreamContent(new CancelBody(cancellation))}); }
    }
    private sealed class CancelBody(CancellationTokenSource cancellation):Stream
    {
        public override bool CanRead=>true;public override bool CanSeek=>false;public override bool CanWrite=>false;public override long Length=>throw new NotSupportedException();public override long Position{get=>throw new NotSupportedException();set=>throw new NotSupportedException();}
        public override ValueTask<int> ReadAsync(Memory<byte> buffer,CancellationToken token=default){cancellation.Cancel();return ValueTask.FromCanceled<int>(cancellation.Token);}
        public override int Read(byte[] buffer,int offset,int count)=>throw new NotSupportedException();public override void Flush(){}public override long Seek(long offset,SeekOrigin origin)=>throw new NotSupportedException();public override void SetLength(long value)=>throw new NotSupportedException();public override void Write(byte[] buffer,int offset,int count)=>throw new NotSupportedException();
    }
}
