using AgenticView.Desktop;

var count = 0;
void Check(bool value, string message) { if (!value) throw new Exception(message); count++; }
void Reject(string[] args) { try { DesktopOptions.Parse(args); throw new Exception("Unsafe options accepted"); } catch (ArgumentException) { count++; } }
var options = DesktopOptions.Parse([]);
Check(options.Url.AbsoluteUri == "http://127.0.0.1:4317/", "Default origin changed");
foreach (var url in new[] { "http://example.com", "file:///private", "https://user:secret@example.com", "https://example.com/?key=secret", "https://example.com/#secret", "javascript:alert(1)" }) Reject(["--url", url]);
Reject(["--url"]); Reject(["--unknown"]); Reject(["--data-dir", "\\\\server\\profile"]);
Check(DesktopOptions.Parse(["--url", "https://example.com/hub", "--diagnose"]).Diagnose, "HTTPS or diagnose rejected");
var policy = new BridgePolicy(options.Url);
var message = "{\"type\":\"agenticview:window\",\"action\":\"close\"}";
Check(policy.TryReadAction(options.Url.AbsoluteUri, options.Url.AbsoluteUri, message, out var action) && action == "close", "Valid command rejected");
foreach (var source in new[] { "https://example.com/", "http://127.0.0.1:4318/", "http://127.0.0.1:4317/embed", "about:srcdoc", "data:text/html,anything", "http://user:secret@127.0.0.1:4317/", "http://127.0.0.1:4317/?credential=secret" })
    Check(!policy.TryReadAction(source, options.Url.AbsoluteUri, message, out _), "Untrusted sender accepted");
Check(!policy.TryReadAction(options.Url.AbsoluteUri, "https://other.example/", message, out _), "Navigation race accepted");
foreach (var bad in new[] { "{}", "[]", "null", "{", "{\"type\":\"agenticview:window\",\"action\":42}", "{\"type\":\"agenticview:window\",\"action\":\"execute\"}", "{\"type\":\"agenticview:window\",\"action\":\"close\",\"action\":\"close\"}", new string('x', 257) })
    Check(!policy.TryReadAction(options.Url.AbsoluteUri, options.Url.AbsoluteUri, bad, out _), "Malformed command accepted");
Check(policy.IsTrustedDocument("http://127.0.0.1:4317/#canvas"), "Same document fragment rejected");
Check(policy.InitializationScript.Contains("window===window.top", StringComparison.Ordinal), "Bridge lacks top-level gate");
var inputTrace = "{\"type\":\"agenticview:input-trace\",\"phase\":\"move\",\"values\":[1,20,-10,0]}";
Check(policy.TryReadInputTrace(options.Url.AbsoluteUri, options.Url.AbsoluteUri, inputTrace, out _), "Bounded numeric trace rejected");
Check(!policy.TryReadAction(options.Url.AbsoluteUri, options.Url.AbsoluteUri, inputTrace, out _), "Diagnostic trace granted window authority");
Check(policy.TryReadInputTrace(options.Url.AbsoluteUri, options.Url.AbsoluteUri, inputTrace.Replace("move", "geometry"), out _), "Bounded geometry diagnostic rejected");
foreach (var source in new[] { "https://example.com/", "http://127.0.0.1:4317/api/embeds/run/view", "about:srcdoc" })
    Check(!policy.TryReadInputTrace(source, options.Url.AbsoluteUri, inputTrace, out _), "Untrusted diagnostic source accepted");
foreach (var bad in new[] { "{}", "[]", "null", "{", "{\"type\":42,\"phase\":\"move\",\"values\":[]}", "{\"type\":\"agenticview:input-trace\",\"phase\":\"execute\",\"values\":[]}", "{\"type\":\"agenticview:input-trace\",\"phase\":\"move\",\"values\":[\"private content\"]}", "{\"type\":\"agenticview:input-trace\",\"phase\":\"move\",\"values\":[1e100]}", "{\"type\":\"agenticview:input-trace\",\"phase\":\"move\",\"values\":[],\"secret\":\"never logged\"}", new string('x', 2049) })
    Check(!policy.TryReadInputTrace(options.Url.AbsoluteUri, options.Url.AbsoluteUri, bad, out _), "Malformed or content-bearing trace accepted");
Reject(["--url", "https://example.com/", "--viewer-key-file", "C:\\private\\viewer.txt"]);
Reject(["--viewer-key-file", "\\\\server\\viewer.txt"]);
Reject(["--viewer-key-file", "relative-viewer.txt"]);
Reject(["--viewer-key-file", "C:\\private\\viewer.txt:alternate"]);
var privateFixture = Path.Combine(Path.GetTempPath(), "av-desktop-contract-" + Guid.NewGuid().ToString("N") + ".txt");
try
{
    File.WriteAllText(privateFixture, new string('a', 48));
    var local = DesktopOptions.Parse(["--viewer-key-file", privateFixture, "--diagnose"]);
    Check(local.Diagnose && local.ViewerKeyFile == privateFixture, "Local private bootstrap or diagnose rejected");
    Check(local.ReadViewerKey() == new string('a', 48), "Private key content rejected");
    File.WriteAllText(privateFixture, new string('a', 1025));
    Reject(["--viewer-key-file", privateFixture]);
    File.WriteAllText(privateFixture, "invalid token content");
    try { local.ReadViewerKey(); throw new Exception("Invalid private key accepted"); } catch (ArgumentException) { count++; }
}
finally { File.Delete(privateFixture); }
var card = DesktopOptions.Parse(["--card-id","card-1","--card-name","FX \"alpha\"","--data-dir",Path.Combine(Path.GetTempPath(),"av-card-contract")]);
Check(card.CardId=="card-1"&&card.Windowed,"Standalone card did not select its own window mode");
Check(CardWindowSpec.AppId(card.Url,"card-1")!=CardWindowSpec.AppId(card.Url,"card-2"),"Cards share a taskbar identity");
Check(CardWindowSpec.AppId(card.Url,"card-1")!=CardWindowSpec.AppId(new Uri("http://127.0.0.1:4318/"),"card-1"),"Installations share a taskbar identity");
Check(CardWindowSpec.Quote("a\\b\\")=="\"a\\b\\\\\"","Trailing slash command quoting changed");
Check(CardWindowSpec.Quote("a\"b")=="\"a\\\"b\"","Quote command escaping changed");
Check(CardWindowSpec.Arguments(card).Contains("--card-id")&&!CardWindowSpec.Arguments(card).Contains("--open-card"),"Pinned child would recursively launch another process");
foreach(var value in new[]{"../escape","card\n","__proto__","","a b"})Reject(["--card-id",value]);
Reject(["--card-name","Name"]);Reject(["--open-card"]);Reject(["--card-id","one","--focus-card","two"]);
var popout="{\"type\":\"agenticview:popout\",\"requestId\":\"00000000-0000-4000-8000-000000000001\",\"cardId\":\"card-1\",\"title\":\"FX sample\"}";
Check(policy.TryReadPopOut(options.Url.AbsoluteUri,options.Url.AbsoluteUri,popout,out _,out var popped,out _)&&popped=="card-1","Typed popout rejected");
foreach(var bad in new[]{popout.Replace("card-1","../escape"),popout.Replace("card-1","constructor"),popout.Replace("00000000-0000-4000-8000-000000000001","not-an-id"),popout.Replace("FX sample","Bad\\nname"),popout.Replace("\"title\"","\"executable\""),"[]","{}"})Check(!policy.TryReadPopOut(options.Url.AbsoluteUri,options.Url.AbsoluteUri,bad,out _,out _,out _),"Invalid or executable popout input accepted");
Check(!policy.TryReadPopOut("https://other.example/",options.Url.AbsoluteUri,popout,out _,out _,out _),"Cross-origin popout accepted");
Check(new BridgePolicy(options.Url,"card-1").InitializationScript.Contains("card-1",StringComparison.Ordinal),"Standalone identity was not scoped into native initialization");
Check(DesktopOptions.Parse(["--card-id","card","--card-name","-- Strategy"]).CardName=="-- Strategy","Leading-hyphen title is not an argument option");
var privateCard=card with{ViewerKeyFile=Path.Combine(Path.GetTempPath(),"ephemeral-viewer.key")};
Check(!CardWindowSpec.RelaunchArguments(privateCard).Contains("--viewer-key-file"),"Durable relaunch retains an ephemeral key-file dependency");
Check(!CardWindowSpec.Command("AgenticView.Desktop.exe",privateCard).Contains("ephemeral-viewer",StringComparison.Ordinal),"Taskbar command leaked bootstrap file dependency");
Check(!CardWindowSpec.TaskbarName("@\\\\example.invalid\\resource.dll,-1").StartsWith('@'),"Agent card titles can become Windows indirect resources");
Console.WriteLine($"Passed {count} desktop URL and bridge security contracts.");
