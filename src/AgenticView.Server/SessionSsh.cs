using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace AgenticView.Server;

/// <summary>Fixed SSH transport and a scoped remote CLI bridge. Session data travels only over stdin.</summary>
public static class SessionSsh
{
    private const int EnvelopeLimit = 1_048_576;
    private const int HeartbeatLimit = 4096;
    private const long HeartbeatMilliseconds = 20_000;
    private static readonly string[] ScopedEnvironment = ["AV_URL", "AV_SESSION_ID", "AV_RUN_ID", "AV_SESSION_TOKEN"];
    // Console streams intentionally suppress broken-pipe errors on Windows. A borrowed
    // standard-handle file stream must surface disconnects so the owned CLI cannot linger.
    private static FileStream TransportOutput(bool error)
    {
        var handle = OperatingSystem.IsWindows() ? GetStdHandle(error ? -12 : -11) : new IntPtr(error ? 2 : 1);
        if (handle == IntPtr.Zero || handle == new IntPtr(-1)) throw new IOException("Session transport output is unavailable.");
        try { return new FileStream(new SafeFileHandle(handle, ownsHandle: false), FileAccess.Write, 8192, isAsync: false); }
        catch(ArgumentException) when(OperatingSystem.IsWindows()) { return new FileStream(new SafeFileHandle(handle, ownsHandle: false), FileAccess.Write, 8192, isAsync: true); }
    }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GetStdHandle(int standardHandle);

    public static ProcessStartInfo BuildStart(JsonObject profile)
    {
        if (Json.String(profile, "transport") != "ssh") throw new InvalidDataException("An SSH transport profile is required.");
        ComponentValidator.Choice(profile, "provider", ["codex", "claude", "opencode", "custom"]);
        var host = ComponentValidator.Text(profile, "sshHost", 255, true, 1);
        if (!Regex.IsMatch(host, @"^[A-Za-z0-9_][A-Za-z0-9_.-]*$", RegexOptions.CultureInvariant | RegexOptions.NonBacktracking) && Uri.CheckHostName(host.Trim('[',']'))!=UriHostNameType.IPv6) throw new InvalidDataException("SSH host must be a private alias, host or IP address without login, options or shell syntax.");
        var username = profile.ContainsKey("sshUsername") ? ComponentValidator.Text(profile, "sshUsername", 256, true, 1) : null;
        if (username is not null && !Regex.IsMatch(username, @"^[A-Za-z0-9_][A-Za-z0-9_.@\\-]*$", RegexOptions.CultureInvariant | RegexOptions.NonBacktracking)) throw new InvalidDataException("SSH username must be bounded login data without shell syntax.");
        var credentialEnabled = ComponentValidator.Boolean(profile, "credentialEnabled");
        var shell = profile.ContainsKey("remoteShell") ? ComponentValidator.Text(profile, "remoteShell", 20) : "posix";
        if (shell is not ("posix" or "powershell")) throw new InvalidDataException("Unsupported remote shell.");
        var command = ComponentValidator.Array(profile, "remoteCommand", 128, 1).Select(node =>
        {
            if (node is not JsonValue scalar || !scalar.TryGetValue<string>(out var value) || value.Length > 4096 || value.Contains('\0')) throw new InvalidDataException("Remote command arguments must be bounded fixed strings.");
            return value;
        }).ToArray();
        if (command[0].Length == 0) throw new InvalidDataException("A fixed remote executable is required.");
        var executable = profile.ContainsKey("sshExecutable") ? ComponentValidator.Text(profile, "sshExecutable", 2048, true, 1) : "ssh";
        if (executable.IndexOfAny(['\r', '\n', '\0']) >= 0) throw new InvalidDataException("SSH executable is invalid.");
        var start = new ProcessStartInfo { FileName = executable, UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var argument in new[] { "-T", "-o", credentialEnabled ? "BatchMode=no" : "BatchMode=yes", "-o", "ConnectTimeout=10" }) start.ArgumentList.Add(argument);
        if (credentialEnabled) foreach (var argument in new[] { "-o", "NumberOfPasswordPrompts=1", "-o", "PreferredAuthentications=password,keyboard-interactive" }) start.ArgumentList.Add(argument);
        if (username is not null) { start.ArgumentList.Add("-l"); start.ArgumentList.Add(username); }
        if (profile.ContainsKey("sshPort")) { start.ArgumentList.Add("-p"); start.ArgumentList.Add(((int)ComponentValidator.Number(profile, "sshPort", 1, 65535, true, true)).ToString(CultureInfo.InvariantCulture)); }
        start.ArgumentList.Add("--"); start.ArgumentList.Add(host);
        static string Posix(string value) => "'" + value.Replace("'", "'\"'\"'", StringComparison.Ordinal) + "'";
        static string PowerShell(string value) => "'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
        var quoted = shell == "powershell" ? "& " + string.Join(' ', command.Select(PowerShell)) : string.Join(' ', command.Select(Posix));
        if (quoted.Length > 16384) throw new InvalidDataException("The fixed remote command exceeds its transport bound.");
        const string ready="{\"agenticviewSshAuthenticated\":true}";
        start.ArgumentList.Add(shell == "powershell" ? "Write-Output '"+ready+"'; "+quoted : "printf '%s\\n' '"+ready+"'; "+quoted);
        return start;
    }

    // StreamReader.ReadLine would retain an unlimited line before its caller could reject it.
    private static async Task<string?> ReadLineBounded(StreamReader reader, int limit, CancellationToken cancellation)
    {
        var text = new StringBuilder(Math.Min(limit, 4096)); var one = new char[1];
        for (;;)
        {
            cancellation.ThrowIfCancellationRequested();
            var count = await reader.ReadAsync(one.AsMemory(), cancellation);
            if (count == 0) return text.Length == 0 ? null : text.ToString().TrimEnd('\r');
            if (one[0] == '\n') return text.ToString().TrimEnd('\r');
            if (text.Length >= limit) throw new InvalidDataException("Session transport line exceeds its bound.");
            text.Append(one[0]);
        }
    }

    public static async Task<int> RunStdio(string path, CancellationToken ct)
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(ct);
        using var input = Console.OpenStandardInput();
        using var reader = new StreamReader(input, new UTF8Encoding(false, true), false, 4096, true);
        Process? process = null; SessionJob? containment = null;
        Task? stdout = null, stderr = null, monitor = null, watchdog = null;
        void Stop() { try { lifetime.Cancel(); } catch (ObjectDisposedException) { } }
        void KillOwned()
        {
            if (process is null) return;
            try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch (Exception error) when (error is InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException) { }
        }
        using var killOnCancel = lifetime.Token.Register(KillOwned);
        try
        {
            using var initialDeadline = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token); initialDeadline.CancelAfter(TimeSpan.FromSeconds(20));
            var line = await ReadLineBounded(reader, EnvelopeLimit, initialDeadline.Token) ?? throw new InvalidDataException("Session envelope unavailable.");
            var envelope = JsonNode.Parse(line, documentOptions: new JsonDocumentOptions { MaxDepth = 12 }) as JsonObject ?? throw new InvalidDataException("Session envelope must be an object.");
            ComponentValidator.Budget(envelope);
            if (envelope.Any(pair => pair.Key is not ("prompt" or "nativeSessionId" or "environment"))) throw new InvalidDataException("Unsupported session envelope field.");
            var prompt = ComponentValidator.Text(envelope, "prompt", EnvelopeLimit);
            string? native = null;
            if (envelope["nativeSessionId"] is not null) { native = ComponentValidator.Text(envelope, "nativeSessionId", 4096, true, 1); if (native.IndexOfAny(['\r', '\n', '\0']) >= 0) throw new InvalidDataException("Native session identity is invalid."); }
            var environment = ComponentValidator.Object(envelope["environment"]);
            if (environment.Count != ScopedEnvironment.Length || environment.Any(pair => !ScopedEnvironment.Contains(pair.Key, StringComparer.Ordinal))) throw new InvalidDataException("Only scoped session environment fields are permitted.");
            foreach (var name in ScopedEnvironment) ComponentValidator.Text(environment, name, name == "AV_URL" ? 2048 : 512, true, 1);
            ComponentValidator.Id(environment, "AV_SESSION_ID"); ComponentValidator.Id(environment, "AV_RUN_ID");
            if (!Uri.TryCreate(Json.String(environment, "AV_URL"), UriKind.Absolute, out var hub) || hub.Scheme is not ("http" or "https") || hub.UserInfo.Length > 0 || hub.AbsolutePath != "/" || hub.Query.Length > 0 || hub.Fragment.Length > 0) throw new InvalidDataException("Session reporting origin is invalid.");
            if (environment.Any(pair => pair.Value!.GetValue<string>().IndexOfAny(['\r', '\n', '\0']) >= 0)) throw new InvalidDataException("Scoped session environment is invalid.");
            var profilePath = Path.GetFullPath(path);
            if (new FileInfo(profilePath).Length > 262144) throw new InvalidDataException("Remote session profile exceeds its bound.");
            var profile = JsonNode.Parse(await File.ReadAllTextAsync(profilePath, lifetime.Token), documentOptions: new JsonDocumentOptions { MaxDepth = 48 }) as JsonObject ?? throw new InvalidDataException("Remote session profile is invalid.");
            ComponentValidator.Budget(profile);
            if (Json.String(profile, "type") != "agent-session" || Json.String(profile, "transport") == "ssh") throw new InvalidDataException("The remote profile must be a local agent-session handler.");
            if (profile["workingDirectory"] is JsonValue directory && directory.TryGetValue<string>(out var working) && !Path.IsPathRooted(working)) profile["workingDirectory"] = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(profilePath)!, working));
            var start = SessionRunner.BuildStart(profile, prompt, native);
            foreach (var key in start.Environment.Keys.Where(key => key.StartsWith("AV_", StringComparison.OrdinalIgnoreCase)).ToArray()) start.Environment.Remove(key);
            foreach (var name in ScopedEnvironment) start.Environment[name] = environment[name]!.GetValue<string>();
            process = new Process { StartInfo = start }; process.Start(); containment = SessionJob.Attach(process);
            if (lifetime.IsCancellationRequested) KillOwned();
            var lastHeartbeat = Environment.TickCount64;
            async Task Pump(Stream source, Stream destination)
            {
                try { var buffer = new byte[8192]; int count; while ((count = await source.ReadAsync(buffer, lifetime.Token)) != 0) { await destination.WriteAsync(buffer.AsMemory(0, count), lifetime.Token); await destination.FlushAsync(lifetime.Token); } }
                catch (Exception error) when (error is IOException or OperationCanceledException or ObjectDisposedException) { Stop(); }
            }
            async Task Monitor()
            {
                try
                {
                    for (;;)
                    {
                        var heartbeat = await ReadLineBounded(reader, HeartbeatLimit, lifetime.Token);
                        if (heartbeat is null) { Stop(); return; }
                        var ping = JsonNode.Parse(heartbeat, documentOptions: new JsonDocumentOptions { MaxDepth = 4 }) as JsonObject;
                        if (ping is null || ping.Count != 1 || !ComponentValidator.Boolean(ping, "heartbeat")) { Stop(); return; }
                        Interlocked.Exchange(ref lastHeartbeat, Environment.TickCount64);
                    }
                }
                catch (Exception) { Stop(); }
            }
            async Task Watchdog()
            {
                try { while (!lifetime.IsCancellationRequested) { await Task.Delay(250, lifetime.Token); if (Environment.TickCount64 - Interlocked.Read(ref lastHeartbeat) >= HeartbeatMilliseconds) { Stop(); return; } } }
                catch (OperationCanceledException) { }
            }
            using var standardOutput = TransportOutput(false); using var standardError = TransportOutput(true);
            stdout = Pump(process.StandardOutput.BaseStream, standardOutput); stderr = Pump(process.StandardError.BaseStream, standardError);
            monitor = Monitor(); watchdog = Watchdog();
            try { if (Json.String(profile, "promptTransport") != "argument") await process.StandardInput.WriteAsync(prompt.AsMemory(), lifetime.Token); process.StandardInput.Close(); }
            catch (IOException) { /* An early provider exit remains authoritative. */ }
            await process.WaitForExitAsync(lifetime.Token);
            await Task.WhenAll(stdout, stderr).WaitAsync(lifetime.Token);
            return process.ExitCode;
        }
        catch (OperationCanceledException) { return 130; }
        catch (Exception error) {
            try { var log=Path.Combine(Path.GetDirectoryName(Path.GetFullPath(path))!,"session-bridge.errors.jsonl");if(!File.Exists(log)||new FileInfo(log).Length<1048576)await File.AppendAllTextAsync(log,JsonSerializer.Serialize(new{time=DateTimeOffset.UtcNow,type=error.GetType().Name,message=error.Message,innerType=error.InnerException?.GetType().Name})+Environment.NewLine); }catch(Exception){ }
            try { await Console.Error.WriteLineAsync("Remote session bridge failed. Inspect the private remote profile and session-bridge.errors.jsonl; no session credentials were emitted."); } catch (IOException) { } return 2;
        }
        finally
        {
            Stop(); KillOwned();
            if (process is not null) { try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(2)); } catch (Exception) { } }
            containment?.Dispose();
            var tasks = new[] { stdout, stderr, monitor, watchdog }.Where(task => task is not null).Cast<Task>().ToArray();
            try { await Task.WhenAll(tasks).WaitAsync(TimeSpan.FromSeconds(2)); } catch (Exception) { }
            process?.Dispose();
        }
    }
}
