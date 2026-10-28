using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Net.Http.Headers;

namespace AgenticView.Server;

// This cache is confined to public files below WebRoot; never API, embeds or SSE.
public sealed partial class WebAssets : IDisposable
{
    private readonly string root;
    private readonly MemoryCache cache = new(new MemoryCacheOptions { SizeLimit = 64 * 1024 * 1024 });
    private readonly object gate = new();
    private sealed record Representation(byte[] Bytes, string ETag);
    private sealed record Asset(long Length, DateTime Modified, string Type, Dictionary<string, Representation> Encodings);
    public WebAssets(RuntimeConfig config) => root = Path.GetFullPath(config.WebRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
    public void Dispose() => cache.Dispose();

    public Task<IResult> Get(string? asset, HttpContext context)
    {
        if ((asset ?? "").StartsWith("api/", StringComparison.Ordinal)) return Task.FromResult<IResult>(Results.NotFound(new { error = "API route not found." }));
        var name = string.IsNullOrEmpty(asset) ? "index.html" : asset;
        if (name.Contains('\\') || name.Contains(':') || name.IndexOfAny(Path.GetInvalidPathChars()) >= 0 || name.Split('/').Any(p => p is "." or "..")) return Missing();
        var path = Path.GetFullPath(Path.Combine(root, name));
        if (!path.StartsWith(root, StringComparison.OrdinalIgnoreCase) || !File.Exists(path)) return Missing();
        // Do not follow links out of the configured public tree, including parent links.
        for (var cursor = path; cursor.Length >= root.Length; cursor = Path.GetDirectoryName(cursor)!)
            if ((File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0) return Missing();
        var info = new FileInfo(path);
        var type = Path.GetExtension(path).ToLowerInvariant() switch {
            ".html" => "text/html; charset=utf-8", ".js" or ".mjs" => "text/javascript; charset=utf-8", ".css" => "text/css; charset=utf-8",
            ".json" or ".map" => "application/json; charset=utf-8", ".svg" => "image/svg+xml", ".woff2" => "font/woff2", ".woff" => "font/woff", ".wasm" => "application/wasm", ".txt" => "text/plain; charset=utf-8", _ => "application/octet-stream" };
        context.Response.Headers.CacheControl = Path.GetExtension(path).Equals(".html", StringComparison.OrdinalIgnoreCase) ? "no-cache" : name.StartsWith("assets/", StringComparison.Ordinal) && Fingerprint().IsMatch(name) ? "public,max-age=31536000,immutable" : "public,max-age=3600";
        if (info.Length > 8 * 1024 * 1024) return Task.FromResult<IResult>(Results.File(path, type));
        Asset value;
        lock (gate)
        {
            if (!cache.TryGetValue(path, out Asset? saved) || saved!.Length != info.Length || saved.Modified != info.LastWriteTimeUtc)
            {
                var bytes = File.ReadAllBytes(path);
                var encodings = new Dictionary<string, Representation> { ["identity"] = Make(bytes) };
                if (bytes.Length >= 512 && (type.StartsWith("text/", StringComparison.Ordinal) || type.Contains("json", StringComparison.Ordinal) || type is "image/svg+xml" or "application/wasm"))
                {
                    foreach (var encoding in new[] { "br", "gzip" })
                    {
                        using var output = new MemoryStream();
                        using (Stream compressor = encoding == "br" ? new BrotliStream(output, CompressionLevel.Fastest, true) : new GZipStream(output, CompressionLevel.Fastest, true)) compressor.Write(bytes);
                        var compressed = output.ToArray();
                        if (compressed.Length < bytes.Length) encodings[encoding] = Make(compressed);
                    }
                }
                saved = new(bytes.Length, info.LastWriteTimeUtc, type, encodings);
                cache.Set(path, saved, new MemoryCacheEntryOptions { Size = encodings.Values.Sum(v => (long)v.Bytes.Length), SlidingExpiration = TimeSpan.FromMinutes(20) });
            }
            value = saved;
        }
        context.Response.Headers.Vary = "Accept-Encoding";
        IList<StringWithQualityHeaderValue> accepted = new List<StringWithQualityHeaderValue>();
        if (context.Request.Headers.AcceptEncoding.Count != 0)
        {
            if (!StringWithQualityHeaderValue.TryParseList(context.Request.Headers.AcceptEncoding, out var parsed) || parsed == null) return Task.FromResult<IResult>(Results.StatusCode(400));
            accepted = parsed;
        }
        double Quality(string encoding)
        {
            var explicitValue = accepted.FirstOrDefault(a => a.Value.Equals(encoding, StringComparison.OrdinalIgnoreCase));
            if (explicitValue != null) return explicitValue.Quality ?? 1;
            var wildcard = accepted.FirstOrDefault(a => a.Value.Equals("*", StringComparison.Ordinal));
            return encoding == "identity" ? (wildcard?.Quality == 0 ? 0 : 1) : accepted.Count == 0 ? 0 : wildcard?.Quality ?? 0;
        }
        var selected = new[] { "br", "gzip", "identity" }.Where(value.Encodings.ContainsKey).Select(k => (Key: k, Q: Quality(k))).Where(v => v.Q > 0).OrderByDescending(v => v.Q).FirstOrDefault();
        if (selected.Key == null) return Task.FromResult<IResult>(Results.StatusCode(406));
        var representation = value.Encodings[selected.Key];
        context.Response.Headers.ETag = representation.ETag;
        if (selected.Key != "identity") context.Response.Headers.ContentEncoding = selected.Key;
        var match = context.Request.Headers.IfNoneMatch.ToString().Split(',').Select(s => s.Trim());
        if (match.Any(s => s == "*" || (s.StartsWith("W/", StringComparison.Ordinal) ? s[2..] : s) == representation.ETag)) return Task.FromResult<IResult>(Results.StatusCode(304));
        return Task.FromResult<IResult>(Results.Bytes(representation.Bytes, value.Type));
    }
    private static Representation Make(byte[] bytes) => new(bytes, "\"" + Convert.ToHexString(SHA256.HashData(bytes)) + "\"");
    private static Task<IResult> Missing() => Task.FromResult<IResult>(Results.NotFound(new { error = "Web asset not found. Build the frontend first." }));
    [GeneratedRegex(@"-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$", RegexOptions.CultureInvariant)]
    private static partial Regex Fingerprint();
}
