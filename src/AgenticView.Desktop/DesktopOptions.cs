namespace AgenticView.Desktop;

public sealed record DesktopOptions(Uri Url, string DataDirectory, bool Diagnose, string? ViewerKeyFile = null)
{
    public static DesktopOptions Parse(string[] args)
    {
        var url = "http://127.0.0.1:4317/";
        var data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AgenticView", "Desktop");
        var diagnose = false;
        string? viewerKeyFile = null;
        for (var index = 0; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--url": url = Value(args, ref index); break;
                case "--data-dir": data = Value(args, ref index); break;
                case "--diagnose": diagnose = true; break;
                case "--viewer-key-file": viewerKeyFile = Value(args, ref index); break;
                default: throw new ArgumentException("Supported options: --url, --data-dir, --viewer-key-file, --diagnose.");
            }
        }
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
            (uri.Scheme != "https" && !(uri.Scheme == "http" && uri.IsLoopback)) ||
            uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0)
            throw new ArgumentException("The URL must use HTTPS or loopback HTTP, without credentials, query or fragment.");
        if (string.IsNullOrWhiteSpace(data) || data.IndexOfAny(['\"', '\r', '\n']) >= 0)
            throw new ArgumentException("A private local data directory is required.");
        var fullPath = Path.GetFullPath(data);
        if (fullPath.StartsWith("\\\\", StringComparison.Ordinal)) throw new ArgumentException("The profile directory must be local.");
        if (viewerKeyFile is not null)
        {
            if (!uri.IsLoopback) throw new ArgumentException("Private viewer-key bootstrap is restricted to loopback URLs.");
            viewerKeyFile = ValidateViewerKeyFile(viewerKeyFile);
        }
        return new(uri, fullPath, diagnose, viewerKeyFile);
    }

    public static string ValidateViewerKeyFile(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path) || path.StartsWith("\\\\", StringComparison.Ordinal) ||
            path.IndexOfAny(['\"', '\r', '\n', '*', '?', '<', '>', '|']) >= 0 || path.AsSpan(2).Contains(':'))
            throw new ArgumentException("The viewer-key file must be a plain absolute local file path.");
        var fullPath = Path.GetFullPath(path);
        for (var cursor = fullPath; cursor is not null; cursor = Path.GetDirectoryName(cursor))
            if ((File.Exists(cursor) || Directory.Exists(cursor)) && (File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0)
                throw new ArgumentException("The viewer-key file cannot use links or reparse points.");
        if (!File.Exists(fullPath) || new FileInfo(fullPath).Length is < 1 or > 1024)
            throw new ArgumentException("The viewer-key file must contain at most 1 KiB.");
        return fullPath;
    }

    public string ReadViewerKey()
    {
        if (ViewerKeyFile is null || !Url.IsLoopback) throw new ArgumentException("No loopback viewer-key bootstrap is configured.");
        var path = ValidateViewerKeyFile(ViewerKeyFile);
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (stream.Length is < 1 or > 1024) throw new ArgumentException("Invalid private viewer-key file length.");
        using var reader = new StreamReader(stream, System.Text.Encoding.UTF8, true, 1024);
        var key = reader.ReadToEnd().Trim();
        if (key.Length is < 32 or > 256 || key.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('-' or '_')))
            throw new ArgumentException("Invalid private viewer-key file content.");
        return key;
    }

    private static string Value(string[] args, ref int index)
    {
        if (++index >= args.Length || args[index].StartsWith("--", StringComparison.Ordinal)) throw new ArgumentException("An option value is missing.");
        return args[index];
    }
}
