using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace AgenticView.Server;

public sealed record Secrets(string ViewerToken, string IngestToken, string RunSecret);
public sealed class HubError(int status, string message) : Exception(message) { public int Status { get; } = status; }
public static class Json
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web) { MaxDepth = 48 };
    public static JsonObject Object(object value) => JsonSerializer.SerializeToNode(value, Options)!.AsObject();
    public static string Text(JsonNode value) => value.ToJsonString(Options);
    public static string String(JsonObject value, string key) => value[key]?.GetValue<string>() ?? "";
}
public sealed record RuntimeConfig(string DataDir, string Host, int Port, Uri PublicUrl, Secrets Secrets, string WebRoot)
{
    public bool Local => Host is "127.0.0.1" or "localhost" or "::1";
    public static RuntimeConfig Load()
    {
        var directory = Path.GetFullPath(Environment.GetEnvironmentVariable("AV_DATA_DIR") ?? ".agenticview");
        var host = Environment.GetEnvironmentVariable("AV_HOST") ?? "127.0.0.1";
        if (!int.TryParse(Environment.GetEnvironmentVariable("AV_PORT") ?? "4317", out var port) || port is < 1 or > 65535) throw new InvalidOperationException("AV_PORT must be a valid port.");
        var origin = new Uri(Environment.GetEnvironmentVariable("AV_PUBLIC_URL") ?? $"http://127.0.0.1:{port}");
        if (origin.Scheme is not ("https" or "http") || origin.UserInfo.Length != 0 || origin.AbsolutePath != "/" || origin.Query.Length != 0 || origin.Fragment.Length != 0) throw new InvalidOperationException("AV_PUBLIC_URL must be an HTTP(S) origin without credentials or a path.");
        if (host is not ("127.0.0.1" or "localhost" or "::1") && (Environment.GetEnvironmentVariable("AV_PUBLIC_URL") is null || origin.Scheme != "https" && Environment.GetEnvironmentVariable("AV_ALLOW_HTTP") != "1")) throw new InvalidOperationException("Remote binding requires AV_PUBLIC_URL with HTTPS, or AV_ALLOW_HTTP=1 for an explicitly trusted private network.");
        return new(directory, host, port, origin, LoadSecrets(directory), Path.GetFullPath(Environment.GetEnvironmentVariable("AV_WEB_ROOT") ?? Path.Combine(AppContext.BaseDirectory, "wwwroot")));
    }
    public static Secrets LoadSecrets(string directory)
    {
        Directory.CreateDirectory(directory); var path = Path.Combine(directory, "credentials.json");
        if (File.Exists(path))
        {
            var value = JsonSerializer.Deserialize<Secrets>(File.ReadAllText(path), Json.Options) ?? throw new InvalidDataException("Invalid credentials file.");
            if (value.ViewerToken.Length < 32 || value.IngestToken.Length < 32 || value.RunSecret.Length < 32) throw new InvalidDataException("Invalid credential length.");
            return value;
        }
        static string Key() => Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        var secrets = new Secrets(Key(), Key(), Key());
        using (var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None)) JsonSerializer.Serialize(file, secrets, Json.Options);
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        return secrets;
    }
}
public static class Authentication
{
    public static bool Equal(string a, string b) => CryptographicOperations.FixedTimeEquals(SHA256.HashData(Encoding.UTF8.GetBytes(a)), SHA256.HashData(Encoding.UTF8.GetBytes(b)));
    private static string Sign(string text, string key) => Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(key), Encoding.UTF8.GetBytes(text))).ToLowerInvariant();
    public static string Bearer(HttpRequest request) { var value = request.Headers.Authorization.ToString(); return value.StartsWith("Bearer ", StringComparison.Ordinal) ? value[7..] : ""; }
    public static bool Viewer(HttpRequest request, Secrets secrets)
    {
        if (Equal(Bearer(request), secrets.ViewerToken)) return true;
        if (!request.Cookies.TryGetValue("av_session", out var cookie)) return false;
        var parts = cookie.Split('.');
        return parts.Length == 3 && long.TryParse(parts[1], out var expires) && expires > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() && Equal(parts[2], Sign(parts[0] + "." + parts[1], secrets.ViewerToken));
    }
    public static string Session(Secrets secrets)
    {
        var value = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)) + "." + DateTimeOffset.UtcNow.AddHours(12).ToUnixTimeMilliseconds();
        return value + "." + Sign(value, secrets.ViewerToken);
    }
}
