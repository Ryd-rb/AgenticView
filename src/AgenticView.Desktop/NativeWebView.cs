using Microsoft.Web.WebView2.Core;

namespace AgenticView.Desktop;

// Public WebView2 controller APIs keep rendering visibility separate from the HWND.
internal sealed class NativeWebView : Control
{
    private CoreWebView2Controller? controller;
    private bool hostVisible=true;
    private Size? testViewport;
    [System.ComponentModel.DesignerSerializationVisibility(System.ComponentModel.DesignerSerializationVisibility.Hidden)]
    public Color DefaultBackgroundColor {get;set;}=Color.FromArgb(13,17,25);
    public CoreWebView2 CoreWebView2=>controller?.CoreWebView2??throw new InvalidOperationException("WebView is not initialized.");
    public void CloseController(){controller?.Close();controller=null;}
    public bool Ready=>controller is not null;
    public async Task EnsureCoreWebView2Async(CoreWebView2Environment environment)
    {
        if(controller is not null)return;
        var created=await environment.CreateCoreWebView2ControllerAsync(Handle);
        if(IsDisposed){created.Close();return;}
        controller=created;controller.DefaultBackgroundColor=DefaultBackgroundColor;
        controller.RasterizationScaleChanged+=(_,_)=>UpdateController();
        controller.AcceleratorKeyPressed+=(_,e)=>{if(e.KeyEventKind is CoreWebView2KeyEventKind.KeyDown or CoreWebView2KeyEventKind.SystemKeyDown){var key=new KeyEventArgs((Keys)e.VirtualKey);OnKeyDown(key);e.Handled=key.Handled||key.SuppressKeyPress;}};
        controller.MoveFocusRequested+=(_,e)=>{if(FindForm() is{} form){form.SelectNextControl(this,e.Reason==CoreWebView2MoveFocusReason.Next,true,true,true);e.Handled=true;}};
        UpdateController();
    }
    public void SetHostVisibility(bool visible){hostVisible=visible;UpdateController();}
    public void NotifyHostPosition(){if(controller is not null&&!IsDisposed)controller.NotifyParentWindowPositionChanged();}
    public void SetTestViewport(Size? logical){testViewport=logical;UpdateController();}
    private void UpdateController()
    {
        if(controller is null||IsDisposed)return;
        var scale=controller.RasterizationScale;
        controller.Bounds=testViewport is{} size?new Rectangle(0,0,Math.Max(1,(int)Math.Round(size.Width*scale)),Math.Max(1,(int)Math.Round(size.Height*scale))):ClientRectangle;
        controller.IsVisible=hostVisible||testViewport is not null;
    }
    protected override void OnResize(EventArgs e){base.OnResize(e);UpdateController();}
    protected override void OnGotFocus(EventArgs e){base.OnGotFocus(e);controller?.MoveFocus(CoreWebView2MoveFocusReason.Programmatic);}
    protected override void Dispose(bool disposing){if(disposing){controller?.Close();controller=null;}base.Dispose(disposing);}
}
