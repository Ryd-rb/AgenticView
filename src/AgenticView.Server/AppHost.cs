using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;
using ModelContextProtocol.AspNetCore;

namespace AgenticView.Server;

public static class AppHost
{
    public static WebApplication Build(string[] args, RuntimeConfig config)
    {
        var builder = WebApplication.CreateBuilder(args);
        builder.Logging.SetMinimumLevel(LogLevel.Warning);
        builder.WebHost.UseUrls($"http://{(config.Host == "::1" ? "[::1]" : config.Host)}:{config.Port}");
        builder.WebHost.ConfigureKestrel(k => { k.Limits.MaxRequestBodySize = 1_048_576; k.Limits.MaxRequestHeadersTotalSize = 16_384; k.Limits.RequestHeadersTimeout = TimeSpan.FromSeconds(10); });
        builder.Services.ConfigureHttpJsonOptions(o => { o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase; o.SerializerOptions.MaxDepth = 48; });
        builder.Services.AddSingleton(config);
        builder.Services.AddSingleton(new Hub(config.DataDir, config.Secrets));
        builder.Services.AddHostedService<HubTicker>();
        builder.Services.AddRateLimiter(o => { o.RejectionStatusCode = 429; o.AddPolicy("login", c => RateLimitPartition.GetFixedWindowLimiter(c.Connection.RemoteIpAddress?.ToString() ?? "local", _ => new FixedWindowRateLimiterOptions { PermitLimit = 10, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 })); });
        builder.Services.AddMcpServer().WithHttpTransport(o => o.SessionMode = HttpServerSessionMode.Stateless).WithTools<McpTools>();
        var app = builder.Build();
        var hub = app.Services.GetRequiredService<Hub>();
        var authority = config.PublicUrl.GetLeftPart(UriPartial.Authority);
        var streamCount = 0;
        app.Use(async (context, next) =>
        {
            try
            {
                var host = context.Request.Host;
                var allowedHost = host.Equals(new HostString(config.PublicUrl.Authority)) || (config.Local && (host.Host is "127.0.0.1" or "localhost" or "::1" or "[::1]") && host.Port == (config.Port == 0 ? context.Connection.LocalPort : config.Port));
                if (!allowedHost) throw new HubError(403, "Host is not configured for this installation.");
                var origin = context.Request.Headers.Origin.ToString();
                var localOrigin = config.Local && (origin == $"http://127.0.0.1:{context.Connection.LocalPort}" || origin == $"http://localhost:{context.Connection.LocalPort}" || origin is "http://127.0.0.1:5173" or "http://localhost:5173");
                if (origin.Length != 0 && origin != authority && !localOrigin) throw new HubError(403, "Origin is not permitted.");
                context.Response.Headers.XContentTypeOptions = "nosniff";
                context.Response.Headers["Referrer-Policy"] = "no-referrer";
                context.Response.Headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()";
                context.Response.Headers.ContentSecurityPolicy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
                var path = context.Request.Path.Value ?? "/";
                if (path.StartsWith("/mcp", StringComparison.Ordinal) || path == "/api/agents/register")
                {
                    if (!Authentication.Equal(Authentication.Bearer(context.Request), config.Secrets.IngestToken)) throw new HubError(401, "A valid ingestion key is required.");
                }
                else if (path.StartsWith("/api/", StringComparison.Ordinal) && path is not ("/api/login" or "/api/logout" or "/api/session") && !IsProducerRoute(path) && !Authentication.Viewer(context.Request, config.Secrets)) throw new HubError(401, "Sign in with your viewer key.");
                await next(context);
            }
            catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested) { }
            catch (Exception error)
            {
                if (context.Response.HasStarted) { context.Abort(); return; }
                context.Response.Clear();
                context.Response.StatusCode = error switch { HubError h => h.Status, JsonException => 400, BadHttpRequestException b => b.StatusCode, _ => 500 };
                await context.Response.WriteAsJsonAsync(new { error = error switch { HubError h => h.Message, JsonException => "Invalid JSON or structure depth exceeded.", BadHttpRequestException => "Invalid or oversized request.", _ => "Internal operation failed. Local state is retained." } });
            }
        });
        app.UseRateLimiter();
        app.MapGet("/health", () => new { status = "ok", version = "0.1.2", runtime = ".NET 10" });
        app.MapGet("/api/session", (HttpContext c) => new { authenticated = Authentication.Viewer(c.Request, config.Secrets) });
        app.MapPost("/api/login", (Func<HttpContext, Task<IResult>>)(async c =>
        {
            var input = await Body(c);
            if (!Authentication.Equal(Json.String(input, "token"), config.Secrets.ViewerToken)) throw new HubError(401, "Invalid viewer key.");
            c.Response.Cookies.Append("av_session", Authentication.Session(config.Secrets), new CookieOptions { HttpOnly = true, SameSite = SameSiteMode.Strict, Secure = config.PublicUrl.Scheme == "https", Path = "/", MaxAge = TimeSpan.FromHours(12) });
            return Results.Json(new { authenticated = true });
        })).RequireRateLimiting("login");
        app.MapPost("/api/logout", (HttpContext c) => { c.Response.Cookies.Delete("av_session"); return new { authenticated = false }; });
        app.MapGet("/api/snapshot", () => hub.Snapshot());
        app.MapPost("/api/agents/register", (Func<HttpContext, Task<IResult>>)(async c => Results.Json(hub.Register(await Body(c)), statusCode: 201)));
        app.MapPost("/api/agents/{id}/publish", async (string id, HttpContext c) => hub.Publish(id, Authentication.Bearer(c.Request), await Body(c)));
        app.MapPost("/api/agents/{id}/heartbeat", (string id, HttpContext c) => hub.Heartbeat(id, Authentication.Bearer(c.Request)));
        app.MapPost("/api/agents/{id}/archive", (string id, HttpContext c) => { if (!Authentication.Viewer(c.Request, config.Secrets)) hub.AuthorizeArchive(id, Authentication.Bearer(c.Request)); return hub.Archive(id); });
        app.MapPatch("/api/agents/{id}/layout", async (string id, HttpContext c) => hub.SetLayout(id, await Body(c)));
        app.MapPost("/api/agents/{id}/layout/manual", (string id) => hub.MarkManual(id));
        app.MapPost("/api/layout/pack", async (HttpContext c) => hub.PackLayout(await Body(c)));
        app.MapPut("/api/settings", (Func<HttpContext, Task<JsonObject>>)(async c => hub.SetSettings(await Body(c))));
        app.MapGet("/api/connection", () => new { mcpUrl = authority + "/mcp", ingestUrl = authority + "/api/agents/register", credentialHelp = "Run dotnet run --project src/AgenticView.Server -- --keys on the server with the same AV_DATA_DIR. Give agents only the ingestion key; every run receives its own write token." });
        app.MapGet("/api/archives", (int? offset, int? limit) => hub.Archives(Math.Max(0, offset ?? 0), Math.Clamp(limit ?? 1000, 1, 1000)));
        app.MapGet("/api/archives/{id}", (string id) => hub.ReadArchive(id));
        app.MapPost("/api/archives/{id}/restore", (string id) => hub.Restore(id));
        app.MapGet("/api/archives/{id}/export", (string id) => Results.File(hub.ArchiveBytes(id), "application/gzip", $"agenticview-{SafeId(id)}.json.gz"));
        app.MapPost("/api/demo", () => Demo.Seed(hub));
        app.MapGet("/api/embeds/{id}/{componentId}", (string id, string componentId, HttpContext c) =>
        {
            var component = hub.GetRun(id)?["components"]?[componentId] as JsonObject;
            if (hub.Settings["trustedEmbeds"]?.GetValue<bool>() != true || component?["kind"]?.GetValue<string>() != "embed") throw new HubError(404, "Trusted embedded view unavailable.");
            c.Response.Headers.ContentSecurityPolicy = "sandbox allow-scripts allow-forms allow-popups allow-downloads; default-src https: http: data: blob:; script-src 'unsafe-inline' 'unsafe-eval' https: http: blob:; style-src 'unsafe-inline' https: http:; connect-src https: http: ws: wss:; img-src https: http: data: blob:; font-src https: http: data:; frame-src https: http: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'";
            c.Response.Headers.CacheControl = "no-store";
            return Results.Content(EmbedDocument(component!["data"]!["html"]!.GetValue<string>()), "text/html; charset=utf-8");
        });
        app.MapGet("/api/events", async (HttpContext c) =>
        {
            if (Interlocked.Increment(ref streamCount) > 16) { Interlocked.Decrement(ref streamCount); throw new HubError(429, "Viewer stream capacity reached."); }
            using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(c.RequestAborted);
            cancellation.CancelAfter(TimeSpan.FromHours(12));
            var channel = Channel.CreateBounded<string>(new BoundedChannelOptions(8) { FullMode = BoundedChannelFullMode.Wait, SingleReader = true, SingleWriter = false });
            void Patch(JsonObject patch) { var text = Json.Text(patch); if (text.Length > 2_097_152 || !channel.Writer.TryWrite(text)) cancellation.Cancel(); }
            hub.Patched += Patch;
            try
            {
                c.Response.ContentType = "text/event-stream"; c.Response.Headers.CacheControl = "no-store"; c.Response.Headers["X-Accel-Buffering"] = "no";
                await c.Response.WriteAsync($"retry: 1500\nevent: snapshot\ndata: {Json.Text(hub.Snapshot())}\n\n", cancellation.Token); await c.Response.Body.FlushAsync(cancellation.Token);
                await foreach (var patch in channel.Reader.ReadAllAsync(cancellation.Token)) { await c.Response.WriteAsync($"event: patch\ndata: {patch}\n\n", cancellation.Token); await c.Response.Body.FlushAsync(cancellation.Token); }
            }
            catch (OperationCanceledException) { }
            finally { hub.Patched -= Patch; Interlocked.Decrement(ref streamCount); }
        });
        app.MapMcp("/mcp");
        app.MapGet("/{**asset}", async (string? asset, HttpContext c) =>
        {
            if ((asset ?? "").StartsWith("api/", StringComparison.Ordinal)) return Results.NotFound(new { error = "API route not found." });
            var root = Path.GetFullPath(config.WebRoot);
            var path = Path.GetFullPath(Path.Combine(root, string.IsNullOrEmpty(asset) ? "index.html" : asset));
            if (!path.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || !File.Exists(path)) return Results.NotFound(new { error = "Web asset not found. Build the frontend first." });
            c.Response.Headers.CacheControl = path.EndsWith("index.html", StringComparison.Ordinal) ? "no-cache" : "public,max-age=3600";
            var contentType = Path.GetExtension(path) switch { ".html" => "text/html; charset=utf-8", ".js" => "text/javascript; charset=utf-8", ".css" => "text/css; charset=utf-8", ".svg" => "image/svg+xml", _ => "application/octet-stream" };
            return Results.Bytes(await File.ReadAllBytesAsync(path, c.RequestAborted), contentType);
        });
        return app;
    }
    private static bool IsProducerRoute(string path) => path.StartsWith("/api/agents/", StringComparison.Ordinal) && (path.EndsWith("/publish", StringComparison.Ordinal) || path.EndsWith("/heartbeat", StringComparison.Ordinal) || path.EndsWith("/archive", StringComparison.Ordinal));
    private static string SafeId(string value) => value.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_') ? value : throw new HubError(400, "Invalid archive identifier.");
    private static async Task<JsonObject> Body(HttpContext c)
    {
        if (!(c.Request.ContentType?.StartsWith("application/json", StringComparison.OrdinalIgnoreCase) ?? false)) throw new HubError(415, "Use Content-Type: application/json.");
        return await JsonNode.ParseAsync(c.Request.Body, documentOptions: new JsonDocumentOptions { MaxDepth = 48 }, cancellationToken: c.RequestAborted) as JsonObject ?? throw new HubError(400, "Expected a JSON object.");
    }
    private static string EmbedDocument(string html) => "<!doctype html><meta charset=\"utf-8\"><meta name=\"referrer\" content=\"no-referrer\"><style>html{color-scheme:dark}body{margin:12px;font:13px system-ui;color:#dedee8;background:#121318}</style><script>addEventListener('message',function(e){if(e.source!==parent||e.data?.type!=='agenticview:init'||!e.ports[0])return;const p=e.ports[0];p.onmessage=function(m){window.agenticViewState=m.data;dispatchEvent(new CustomEvent('agenticview:state',{detail:m.data}))};p.start()},{once:true});</script>" + html;
}
public sealed class HubTicker(Hub hub, ILogger<HubTicker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(100)); var count = 0;
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try { if (++count % 10 == 0) hub.Tick(); hub.Flush(); }
            catch (Exception error) { logger.LogError("Hub maintenance failed ({Type}); local state retained.", error.GetType().Name); }
        }
    }
}
