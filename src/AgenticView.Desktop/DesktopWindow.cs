using System.Runtime.InteropServices;
using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace AgenticView.Desktop;

internal sealed class DesktopWindow : Form
{
    private readonly DesktopOptions options;
    private readonly BridgePolicy policy;
    private readonly Icon brandIcon;
    private readonly WebView2 view = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(13, 17, 25) };
    private bool fullscreen = true;
    private bool documentReady;
    private readonly bool traceInput = Environment.GetEnvironmentVariable("AV_INPUT_TRACE") == "1";
    private int traceCount;
    private Rectangle normalBounds;

    public DesktopWindow(DesktopOptions options)
    {
        this.options = options;
        policy = new(options.Url,options.CardId,options.FocusCardId);
        brandIcon = BrandIcon.Create();
        Icon = brandIcon;
        Text = options.CardName??"AgenticView";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        BackColor = view.DefaultBackgroundColor;
        MinimumSize = new(640, 420);
        var monitor = Screen.FromPoint(Cursor.Position);
        normalBounds = new Rectangle(monitor.WorkingArea.X + 60, monitor.WorkingArea.Y + 60,
            Math.Max(640, monitor.WorkingArea.Width - 120), Math.Max(420, monitor.WorkingArea.Height - 120));
        fullscreen=!options.Windowed;
        Bounds = fullscreen?monitor.Bounds:normalBounds;
        Controls.Add(view);
        Shown += async (_, _) => await InitializeAsync();
        if(options.CardId is not null)HandleCreated+=(_,_)=>{TaskbarIdentity.Apply(Handle,CardWindowSpec.AppId(options.Url,options.CardId),CardWindowSpec.Command(Environment.ProcessPath!,options),options.CardName??"AgenticView card",Environment.ProcessPath!+",0");Console.WriteLine(JsonSerializer.Serialize(new{@event="desktop-card-identity",cardId=options.CardId,appId=CardWindowSpec.AppId(options.Url,options.CardId),relaunchConfigured=true}));};
        Resize += (_, _) => PublishState();
    }

    private async Task InitializeAsync()
    {
        try
        {
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: Path.Combine(options.DataDirectory, "webview"));
            if (IsDisposed) return;
            await view.EnsureCoreWebView2Async(environment);
            var core = view.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.IsPinchZoomEnabled = false;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            core.NavigationStarting += (_, e) => { e.Cancel = !policy.IsTrustedDocument(e.Uri); if (!e.Cancel) documentReady = false; };
            core.NavigationCompleted += (_, e) =>
            {
                documentReady = e.IsSuccess && policy.IsTrustedDocument(core.Source);
                Console.WriteLine(JsonSerializer.Serialize(new { @event = "desktop-navigation", ready = documentReady }));
                PublishState();
            };
            core.NewWindowRequested += (_, e) => e.Handled = true;
            core.DownloadStarting += (_, e) => e.Cancel = true;
            core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
            core.WebMessageReceived += (_, e) =>
            {
                if(documentReady&&policy.TryReadPopOut(e.Source,core.Source,e.WebMessageAsJson,out var requestId,out var cardId,out var title)){
                    BeginInvoke(()=>{if(IsDisposed||!documentReady||!policy.IsTrustedDocument(core.Source))return;try{var result=PopOutLauncher.Open(options,cardId,title);core.PostWebMessageAsJson(JsonSerializer.Serialize(new{type="agenticview:popout-result",requestId,ok=true,processId=result.ProcessId,alreadyOpen=result.AlreadyOpen}));}catch(Exception){core.PostWebMessageAsJson(JsonSerializer.Serialize(new{type="agenticview:popout-result",requestId,ok=false,message="The independent card window could not open. Retained profiles were preserved."}));}});return;
                }
                if (documentReady && traceInput && traceCount < 4096 && policy.TryReadInputTrace(e.Source, core.Source, e.WebMessageAsJson, out var input))
                { traceCount++; Console.WriteLine("{\"event\":\"desktop-input\",\"trace\":" + input + "}"); return; }
                if (documentReady && policy.TryReadAction(e.Source, core.Source, e.WebMessageAsJson, out var action))
                    BeginInvoke(() => { if (!IsDisposed && documentReady && policy.IsTrustedDocument(core.Source)) HandleAction(action); });
            };
            view.KeyDown += (_, e) =>
            {
                if (e.KeyCode == Keys.F11)
                {
                    e.Handled = true;
                    e.SuppressKeyPress = true;
                    ToggleFullscreen();
                }
            };
            await core.AddScriptToExecuteOnDocumentCreatedAsync(policy.InitializationScript);
            if (traceInput) await core.AddScriptToExecuteOnDocumentCreatedAsync("if(window===window.top){window.agenticViewInputTraceUntil=" + DateTimeOffset.UtcNow.AddMinutes(10).ToUnixTimeMilliseconds() + ";}");
            if (options.ViewerKeyFile is not null) await SignInLocalPreviewAsync(core);
            if (IsDisposed) return;
            core.Navigate(options.Url.AbsoluteUri);
        }
        catch (Exception)
        {
            if (IsDisposed) return;
            MessageBox.Show(this, "The desktop view could not initialize. Check the WebView2 Runtime and server availability, then relaunch.", "AgenticView", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }

    private async Task SignInLocalPreviewAsync(CoreWebView2 core)
    {
        // Credentials travel only in a bounded loopback HTTP request, never through JavaScript.
        if (!options.Url.IsLoopback) throw new InvalidOperationException("Local sign-in requires loopback.");
        var origin = new Uri(options.Url.GetLeftPart(UriPartial.Authority));
        var cookies = new CookieContainer();
        using var handler = new HttpClientHandler { CookieContainer = cookies, AllowAutoRedirect = false, UseProxy = false };
        using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(5) };
        using var response = await client.PostAsJsonAsync(new Uri(origin, "/api/login"), new { token = options.ReadViewerKey(), remember = true });
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException("Local sign-in failed.");
        var session = cookies.GetCookies(origin)["av_session"];
        if (session is null || !session.HttpOnly || session.Path != "/" || session.Value.Length is < 16 or > 1024)
            throw new InvalidOperationException("Local sign-in did not return a valid private session.");
        if (IsDisposed) return;
        var cookie = core.CookieManager.CreateCookie("av_session", session.Value, options.Url.Host, "/");
        cookie.IsHttpOnly = true;
        cookie.IsSecure = options.Url.Scheme == "https";
        cookie.SameSite = CoreWebView2CookieSameSiteKind.Strict;
        if (session.Expires != DateTime.MinValue) cookie.Expires = session.Expires.ToUniversalTime();
        core.CookieManager.AddOrUpdateCookie(cookie);
        Console.WriteLine("{\"event\":\"desktop-local-session-ready\"}");
    }

    private void HandleAction(string action)
    {
        switch (action)
        {
            case "minimize": WindowState = FormWindowState.Minimized; break;
            case "maximize": case "fullscreen": ToggleFullscreen(); break;
            case "close": Close(); break;
            case "drag":
                if (fullscreen || WindowState != FormWindowState.Normal) break;
                ReleaseCapture();
                SendMessage(Handle, 0x00A1, 2, 0);
                break;
        }
        PublishState();
    }

    private void ToggleFullscreen()
    {
        if (fullscreen)
        {
            fullscreen = false;
            WindowState = FormWindowState.Normal;
            Padding = new Padding(Math.Max(6, (int)Math.Round(6 * DeviceDpi / 96d)));
            Bounds = normalBounds;
        }
        else
        {
            if (WindowState == FormWindowState.Normal) normalBounds = Bounds;
            var monitor = Screen.FromHandle(Handle);
            fullscreen = true;
            WindowState = FormWindowState.Normal;
            Padding = Padding.Empty;
            Bounds = monitor.Bounds;
        }
        PublishState();
    }

    private void PublishState()
    {
        if (!documentReady || view.CoreWebView2 is not { } core || !policy.IsTrustedDocument(core.Source)) return;
        var state = WindowState == FormWindowState.Minimized ? "minimized" : fullscreen ? "fullscreen" : WindowState == FormWindowState.Maximized ? "maximized" : "normal";
        core.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "agenticview:window-state", state }));
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) { if(options.CardId is not null&&IsHandleCreated)TaskbarIdentity.Clear(Handle);Icon = null; brandIcon.Dispose(); }
        base.Dispose(disposing);
    }

    protected override void WndProc(ref Message message)
    {
        const int hitTest = 0x84, displayChange = 0x7E;
        base.WndProc(ref message);
        if (message.Msg == displayChange && fullscreen) Bounds = Screen.FromHandle(Handle).Bounds;
        if (message.Msg != hitTest || fullscreen || WindowState != FormWindowState.Normal) return;
        var point = PointToClient(new Point(unchecked((short)message.LParam.ToInt64()), unchecked((short)(message.LParam.ToInt64() >> 16))));
        var edge = Math.Max(6, (int)Math.Round(6 * DeviceDpi / 96d));
        var left = point.X < edge; var right = point.X >= ClientSize.Width - edge;
        var top = point.Y < edge; var bottom = point.Y >= ClientSize.Height - edge;
        var result = top && left ? 13 : top && right ? 14 : bottom && left ? 16 : bottom && right ? 17 : left ? 10 : right ? 11 : top ? 12 : bottom ? 15 : 1;
        message.Result = result;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReleaseCapture();
    [DllImport("user32.dll")]
    private static extern nint SendMessage(nint window, uint message, nint wParam, nint lParam);
}
