using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace AgenticView.Desktop;

// Radio geometry from lucide-react 0.577.0, icons/radio.js (ISC).
// Copyright (c) Cole Bemis 2013-2026 (Feather portions, MIT),
// and Lucide Contributors 2026.
// Permission to use, copy, modify, and/or distribute this software for any
// purpose with or without fee is hereby granted, provided that the above
// copyright notice and this permission notice appear in all copies.
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
// WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
// MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
// ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
// WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
// ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
// OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
internal static class BrandIcon
{
    public static Icon Create()
    {
        using var bitmap = new Bitmap(64, 64, PixelFormat.Format32bppArgb);
        using (var graphics = Graphics.FromImage(bitmap))
        {
            graphics.Clear(Color.Transparent);
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.ScaleTransform(64f / 24, 64f / 24);
            using var pen = new Pen(Color.FromArgb(181, 162, 250), 2)
            {
                StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round
            };
            // Exact SVG endpoint/radius data, with clockwise small circular arcs.
            Arc(graphics, pen, 16.247f, 7.761f, 6, 8.478f);
            Arc(graphics, pen, 19.075f, 4.933f, 10, 14.134f);
            Arc(graphics, pen, 4.925f, 19.067f, 10, -14.134f);
            Arc(graphics, pen, 7.753f, 16.239f, 6, -8.478f);
            graphics.DrawEllipse(pen, 10, 10, 4, 4); // cx=12, cy=12, r=2
        }
        var handle = bitmap.GetHicon();
        try
        {
            using var borrowed = Icon.FromHandle(handle);
            return (Icon)borrowed.Clone();
        }
        finally { DestroyIcon(handle); }
    }

    private static void Arc(Graphics graphics, Pen pen, float x, float y, float radius, float deltaY)
    {
        var halfChord = deltaY / 2;
        var centerX = x - MathF.Sign(deltaY) * MathF.Sqrt(radius * radius - halfChord * halfChord);
        var centerY = y + halfChord;
        var start = MathF.Atan2(y - centerY, x - centerX) * 180 / MathF.PI;
        var sweep = 2 * MathF.Asin(MathF.Abs(halfChord) / radius) * 180 / MathF.PI;
        graphics.DrawArc(pen, centerX - radius, centerY - radius, radius * 2, radius * 2, start, sweep);
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyIcon(nint handle);
}
