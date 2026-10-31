using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace AgenticView.Desktop;

/// <summary>Native line pictographs from the bounded logical catalogue. No external assets.</summary>
internal static class WindowIconRenderer
{
    public static Icon Create(WindowIconSpec spec)
    {
        spec=WindowIconSpec.Parse(JsonSerializer.SerializeToElement(spec))??throw new ArgumentException("A native icon configuration is required.");
        using var bitmap=new Bitmap(64,64,PixelFormat.Format32bppArgb);
        using(var g=Graphics.FromImage(bitmap))
        {
            g.Clear(spec.Background is null?Color.Transparent:ColorTranslator.FromHtml(spec.Background));
            g.SmoothingMode=SmoothingMode.AntiAlias;g.ScaleTransform(64f/24,64f/24);
            var color=ColorTranslator.FromHtml(spec.Color??"#b5a2fa");
            using var pen=new Pen(color,1.8f){StartCap=LineCap.Round,EndCap=LineCap.Round,LineJoin=LineJoin.Round};
            void L(params float[] p){var points=new PointF[p.Length/2];for(var i=0;i<points.Length;i++)points[i]=new(p[i*2],p[i*2+1]);g.DrawLines(pen,points);}
            void P(params float[] p){var points=new PointF[p.Length/2];for(var i=0;i<points.Length;i++)points[i]=new(p[i*2],p[i*2+1]);g.DrawPolygon(pen,points);}
            void R(float x,float y,float w,float h)=>g.DrawRectangle(pen,x,y,w,h);
            void E(float x,float y,float w,float h)=>g.DrawEllipse(pen,x,y,w,h);
            void A(float x,float y,float w,float h,float start,float sweep)=>g.DrawArc(pen,x,y,w,h,start,sweep);
            void Arrow(bool up){L(12,up?19:5,12,up?5:19);L(7,up?10:14,12,up?5:19,17,up?10:14);}
            switch(spec.Icon)
            {
                case "status": E(5,5,14,14);E(9,9,6,6);break;
                case "signal": E(10,10,4,4);A(5,5,14,14,-42,84);A(2,2,20,20,-45,90);A(5,5,14,14,138,84);A(2,2,20,20,135,90);break;
                case "bot": R(4,7,16,13);L(12,7,12,3,15,3);L(1,12,4,12);L(20,12,23,12);E(7,11,2,2);E(15,11,2,2);L(8,17,16,17);break;
                case "terminal": R(3,4,18,16);L(6,8,10,12,6,16);L(13,16,18,16);break;
                case "code": L(8,6,2,12,8,18);L(16,6,22,12,16,18);L(14,3,10,21);break;
                case "database": E(3,3,18,6);L(3,6,3,18);L(21,6,21,18);A(3,9,18,6,0,180);A(3,15,18,6,0,180);break;
                case "server": R(3,3,18,7);R(3,14,18,7);E(6,5.5f,1,1);E(6,16.5f,1,1);L(11,6.5f,18,6.5f);L(11,17.5f,18,17.5f);break;
                case "search": E(3,3,13,13);L(14,14,21,21);break;
                case "shield": P(12,2,21,6,20,14,17,19,12,22,7,19,4,14,3,6);break;
                case "flask": L(9,3,15,3);L(10,3,10,10,4,20,20,20,14,10,14,3);L(7,15,17,15);break;
                case "gamepad": P(6,7,18,7,22,18,18,20,14,16,10,16,6,20,2,18);L(6,10,6,14);L(4,12,8,12);E(16,10,1,1);E(19,13,1,1);break;
                case "git-branch": E(4,2,4,4);E(16,3,4,4);E(4,18,4,4);L(6,6,6,18);L(18,7,18,11,6,15);break;
                case "bug": E(7,7,10,14);E(9,3,6,5);L(10,3,8,1);L(14,3,16,1);L(2,9,7,11);L(17,11,22,9);L(2,15,7,15);L(17,15,22,15);L(4,21,8,19);L(16,19,20,21);L(12,9,12,20);break;
                case "activity": L(2,12,6,12,9,3,14,21,17,12,22,12);break;
                case "network": R(9,2,6,6);R(2,16,6,6);R(16,16,6,6);L(12,8,12,12,5,12,5,16);L(12,12,19,12,19,16);break;
                case "workflow": R(2,2,7,7);R(15,15,7,7);R(2,15,7,7);L(9,5.5f,18.5f,5.5f,18.5f,15);L(5.5f,9,5.5f,15);break;
                case "cpu": R(6,6,12,12);R(9,9,6,6);foreach(var t in new[]{8,12,16}){L(t,2,t,6);L(t,18,t,22);L(2,t,6,t);L(18,t,22,t);}break;
                case "globe": E(2,2,20,20);E(7,2,10,20);L(2,12,22,12);break;
                case "file": P(5,2,14,2,20,8,20,22,5,22);L(14,2,14,8,20,8);L(8,13,16,13);L(8,17,16,17);break;
                case "folder": P(2,5,9,5,12,8,22,8,22,20,2,20);break;
                case "chart": L(3,3,3,21,22,21);L(6,16,10,10,14,13,20,5);break;
                case "layers": P(12,2,22,8,12,14,2,8);L(2,13,12,19,22,13);L(2,18,12,23,22,18);break;
                case "sparkles": P(12,3,15,9,21,12,15,15,12,21,9,15,3,12,9,9);L(20,1,20,5);L(18,3,22,3);break;
                case "wrench": L(9,11,3,17,3,21,7,21,13,15);L(9,11,8,7,10,3,13,2,12,7,17,12,22,11,21,15,17,17,13,15);break;
                case "rocket": P(9,16,6,13,8,7,15,2,21,2,21,8,16,15,13,18);E(14,5,4,4);L(6,13,2,14,2,20,8,18);L(13,18,11,22,18,22,19,17);L(7,18,3,22);break;
                case "clock": E(2,2,20,20);L(12,6,12,12,16,15);break;
                case "check": E(2,2,20,20);L(6,12,10,16,18,8);break;
                case "alert": P(12,2,23,21,1,21);L(12,8,12,14);E(11.5f,17,1,1);break;
                case "book": P(2,3,10,3,12,5,14,3,22,3,22,20,14,20,12,22,10,20,2,20);L(12,5,12,22);break;
                case "zap": P(13,2,3,14,11,14,10,22,21,9,13,9);break;
                case "lock": case "unlock": R(4,10,16,12);if(spec.Icon=="lock"){A(7,2,10,12,180,180);L(7,8,7,10);L(17,8,17,10);}else{A(9,2,10,12,180,180);L(9,8,9,10);}L(12,15,12,18);break;
                case "play": P(6,3,21,12,6,21);break;
                case "pause": R(5,3,4,18);R(15,3,4,18);break;
                case "power": A(3,3,18,18,-45,270);L(12,2,12,12);break;
                case "plus": L(12,4,12,20);L(4,12,20,12);break;
                case "minus": L(4,12,20,12);break;
                case "save": P(3,3,18,3,21,6,21,21,3,21);R(7,3,9,6);R(7,14,10,7);break;
                case "trash": L(3,6,21,6);L(5,6,6,22,18,22,19,6);L(9,6,9,2,15,2,15,6);L(10,10,10,18);L(14,10,14,18);break;
                case "settings": E(7,7,10,10);E(10,10,4,4);foreach(var angle in Enumerable.Range(0,8)){var r=angle*MathF.PI/4;L(12+7*MathF.Cos(r),12+7*MathF.Sin(r),12+10*MathF.Cos(r),12+10*MathF.Sin(r));}break;
                case "refresh": A(3,3,18,18,35,285);L(20,3,20,9,14,9);break;
                case "copy": R(8,8,13,13);L(16,8,16,2,2,2,2,16,8,16);break;
                case "download": case "upload": Arrow(spec.Icon=="upload");L(3,17,3,22,21,22,21,17);break;
                case "eye": case "eye-off": A(2,5,20,14,180,180);A(2,5,20,14,0,180);E(9,9,6,6);if(spec.Icon=="eye-off")L(2,2,22,22);break;
                case "send": P(2,10,22,2,14,22,10,14);L(10,14,22,2);break;
                case "user": E(8,2,8,8);A(4,13,16,16,180,180);L(4,21,20,21);break;
                case "menu": L(3,5,21,5);L(3,12,21,12);L(3,19,21,19);break;
                case "close": L(5,5,19,19);L(19,5,5,19);break;
                default:throw new ArgumentException("Unknown native icon.");
            }
        }
        var handle=bitmap.GetHicon();
        try{using var borrowed=Icon.FromHandle(handle);return (Icon)borrowed.Clone();}
        finally{DestroyIcon(handle);}
    }

    [DllImport("user32.dll")]
    [return:MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyIcon(nint handle);
}
