using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace AgenticView.Server;

/// <summary>Fixed-destination prompt delivery from a connector, with no host credentials in its payload.</summary>
public static class WebhookHandler
{
    public static Task<JsonObject> Send(JsonObject profile,JsonObject job,CancellationToken cancellation)=>Deliver(profile,job,cancellation,null);
    internal static async Task<JsonObject> Deliver(JsonObject profile,JsonObject job,CancellationToken cancellation,HttpClient? suppliedClient)
    {
        var kind=Json.String(job,"kind");
        var configuredKind=profile.ContainsKey("kind")?ComponentValidator.Text(profile,"kind",20):"prompt";
        if(kind!=configuredKind || kind is not ("prompt" or "custom")) throw new ConnectorFailure("Webhook profiles deliver prompts or custom notifications only.");
        var destination=ComponentValidator.Text(profile,"url",4096,true,1);
        if(!Uri.TryCreate(destination,UriKind.Absolute,out var url) || url.Scheme is not ("https" or "http") || url.UserInfo.Length>0 || url.Fragment.Length>0) throw new ConnectorFailure("Webhook profile requires an HTTP(S) destination without user information or a fragment.");
        if(url.Scheme=="http" && !url.IsLoopback && !ComponentValidator.Boolean(profile,"allowHttp")) throw new ConnectorFailure("A remote HTTP webhook requires allowHttp in its local profile.");
        var attempts=profile.ContainsKey("maxAttempts")?(int)ComponentValidator.Number(profile,"maxAttempts",1,3,true,true):1;
        if(attempts>1 && !ComponentValidator.Boolean(profile,"idempotent")) throw new ConnectorFailure("Webhook retries require a receiver that deduplicates invocation IDs; set idempotent only for such a receiver.");
        var timeout=profile.ContainsKey("timeoutSeconds")?ComponentValidator.Number(profile,"timeoutSeconds",1,30):10;
        var responseLimit=profile.ContainsKey("maxResponseBytes")?(int)ComponentValidator.Number(profile,"maxResponseBytes",1024,262144,true,true):65536;
        var signingKey=Secret(profile,"signingKeyEnv"); var bearer=Secret(profile,"bearerTokenEnv");
        var id=ComponentValidator.Id(job,"id"); var body=Json.Object(new{schemaVersion=1,invocationId=id,runId=Json.String(job,"runId"),actionId=Json.String(job,"actionId"),kind,input=job["input"]?.DeepClone(),createdAt=job["createdAt"]?.DeepClone()});
        ComponentValidator.Budget(body); var bytes=JsonSerializer.SerializeToUtf8Bytes(body,Json.Options);
        if(bytes.Length>262144) throw new ConnectorFailure("Webhook payload exceeds the delivery byte budget.");
        var timestamp=DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture);
        var signature=signingKey is null?null:"sha256="+Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(signingKey),Encoding.UTF8.GetBytes(timestamp+".").Concat(bytes).ToArray()));
        using var transport=suppliedClient is null?new SocketsHttpHandler {AllowAutoRedirect=false,UseCookies=false,UseProxy=false,ConnectTimeout=TimeSpan.FromSeconds(timeout),MaxResponseHeadersLength=16}:null;
        using var ownedClient=transport is null?null:new HttpClient(transport) {Timeout=Timeout.InfiniteTimeSpan};
        var client=suppliedClient??ownedClient!;
        for(var attempt=1;attempt<=attempts;attempt++)
        {
            using var deadline=CancellationTokenSource.CreateLinkedTokenSource(cancellation); deadline.CancelAfter(TimeSpan.FromSeconds(timeout));
            try
            {
                using var request=new HttpRequestMessage(HttpMethod.Post,url);
                request.Content=new ByteArrayContent(bytes); request.Content.Headers.ContentType=new MediaTypeHeaderValue("application/json");
                request.Headers.Add("Idempotency-Key",id); request.Headers.Add("X-AgenticView-Invocation-Id",id); request.Headers.Add("X-AgenticView-Timestamp",timestamp);
                if(signature is not null) request.Headers.Add("X-AgenticView-Signature",signature);
                if(bearer is not null) request.Headers.Authorization=new AuthenticationHeaderValue("Bearer",bearer);
                using var response=await client.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,deadline.Token);
                if(response.IsSuccessStatusCode)
                {
                    // A 2xx already acknowledges delivery. Never resend it because
                    // its optional response body was slow, invalid or oversized.
                    var result=Json.Object(new{delivery=new{state="acknowledged",invocationId=id,attempts=attempt,httpStatus=(int)response.StatusCode,acknowledgedAt=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}});
                    if(response.Content.Headers.ContentLength>responseLimit) { result["responseTruncated"]=true; return result; }
                    try
                    {
                        await using var stream=await response.Content.ReadAsStreamAsync(deadline.Token);
                        var buffer=new byte[responseLimit+1]; var count=0;
                        while(count<buffer.Length) { var read=await stream.ReadAsync(buffer.AsMemory(count),deadline.Token); if(read==0) break; count+=read; }
                        if(count>responseLimit) { result["responseTruncated"]=true; return result; }
                        if(count>0)
                        {
                            var text=Encoding.UTF8.GetString(buffer,0,count);
                            try { var value=JsonNode.Parse(text,documentOptions:new JsonDocumentOptions{MaxDepth=24}); ComponentValidator.Budget(value); result["response"]=value; }
                            catch(Exception error) when(error is JsonException or HubError) { result["response"]=text.Length>4000?text[..4000]+" … [truncated]":text; }
                        }
                    }
                    catch(Exception error) when(error is OperationCanceledException or HttpRequestException or IOException) { result["responseUnavailable"]=true; }
                    if(Encoding.UTF8.GetByteCount(result.ToJsonString())>262144) { result.Remove("response"); result["responseTruncated"]=true; }
                    return result;
                }
                var retry=response.StatusCode is HttpStatusCode.TooManyRequests or HttpStatusCode.BadGateway or HttpStatusCode.ServiceUnavailable or HttpStatusCode.GatewayTimeout;
                if(!retry || attempt==attempts) throw new ConnectorFailure($"Webhook receiver rejected delivery (HTTP {(int)response.StatusCode}).");
            }
            catch(Exception error) when(!cancellation.IsCancellationRequested && error is HttpRequestException or OperationCanceledException)
            {
                if(attempt==attempts) throw new ConnectorUncertainFailure("Webhook delivery could not be verified. Check the receiver's invocation ID before retrying.");
            }
            await Task.Delay(TimeSpan.FromMilliseconds(250*attempt),cancellation);
        }
        throw new ConnectorUncertainFailure("Webhook delivery could not be verified. Check the receiver before retrying.");
    }
    private static string? Secret(JsonObject profile,string key)
    {
        if(!profile.ContainsKey(key)) return null;
        var name=ComponentValidator.Text(profile,key,160,true,1);
        if(name.Any(c=>!char.IsAsciiLetterOrDigit(c) && c!='_')) throw new ConnectorFailure("Webhook secret environment reference is invalid.");
        var value=Environment.GetEnvironmentVariable(name);
        if(string.IsNullOrEmpty(value) || value.Length>8192 || value.Any(c=>c is '\r' or '\n' or '\0')) throw new ConnectorFailure("A webhook secret is unavailable or invalid in the connector environment.");
        return value;
    }
}
