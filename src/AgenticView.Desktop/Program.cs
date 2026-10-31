using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace AgenticView.Desktop;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        var diagnose = args.Contains("--diagnose", StringComparer.Ordinal);
        try
        {
            var options = DesktopOptions.Parse(args);
            if (options.Diagnose)
            {
                var runtime = CoreWebView2Environment.GetAvailableBrowserVersionString();
                Console.WriteLine(JsonSerializer.Serialize(new { ok = true, platform = "windows-x64", runtime, bridgeVersion = 1, initialState = options.Windowed?"normal":"fullscreen", standaloneCard=options.CardId is not null, trustedOrigin = options.Url.GetLeftPart(UriPartial.Authority), profileSeparate = true }));
                return 0;
            }
            Directory.CreateDirectory(options.DataDirectory);
            if(options.OpenCard){var result=PopOutLauncher.Open(options,options.CardId!,options.CardName??"AgenticView card");Console.WriteLine(JsonSerializer.Serialize(new{opened=true,processId=result.ProcessId,alreadyOpen=result.AlreadyOpen}));return 0;}
            using var cardOutput=options.CardId is not null?new StreamWriter(Path.Combine(options.DataDirectory,"stdout.log"),append:true){AutoFlush=true}:null;
            using var cardErrors=options.CardId is not null?new StreamWriter(Path.Combine(options.DataDirectory,"stderr.log"),append:true){AutoFlush=true}:null;
            if(cardOutput is not null)Console.SetOut(cardOutput);
            if(cardErrors is not null)Console.SetError(cardErrors);
            if(options.CardId is not null)TaskbarIdentity.SetProcessIdentity(CardWindowSpec.AppId(options.Url,options.CardId));
            using var custody = new FileStream(Path.Combine(options.DataDirectory, "desktop.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            ApplicationConfiguration.Initialize();
            Console.WriteLine("{\"event\":\"desktop-starting\",\"bridgeVersion\":1}");
            Application.Run(new DesktopWindow(options));
            Console.WriteLine("{\"event\":\"desktop-closed\"}");
            return 0;
        }
        catch (Exception exception)
        {
            // Do not echo option values, URLs, profile paths or browser internals into diagnostics.
            if (diagnose) Console.WriteLine(JsonSerializer.Serialize(new { ok = false, error = exception.GetType().Name, message = exception is ArgumentException ? exception.Message : "Desktop prerequisites or private profile are unavailable." }));
            else MessageBox.Show("AgenticView could not start. Check that the .NET Desktop Runtime, Microsoft Edge WebView2 Runtime and a writable, unused private profile are available.", "AgenticView", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
