"""Render the README's synthetic UI illustration; never captures a browser.

Requires an existing Pillow installation. All names, work and telemetry are
invented. Optional review stills are local working evidence, not test fixtures.
"""
from __future__ import annotations

import argparse
import math
import os
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
W, H, SS = 1000, 600, 2
COLORS = {
    "canvas": "#0d0f13", "surface": "#16191f", "inset": "#11141a",
    "raised": "#1c2028", "text": "#e4e7ed", "secondary": "#b2b9c8",
    "muted": "#929aaa", "faint": "#747f91", "border": "#30353f",
    "accent": "#b8abef", "green": "#88baa6", "yellow": "#d3b17b",
    "red": "#dc929d", "blue": "#8caed8",
}


def font_file(bold: bool = False, mono: bool = False) -> str | None:
    windows = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
    candidates = [windows / ("consola.ttf" if mono else "segoeuib.ttf" if bold else "segoeui.ttf")]
    candidates += [Path("/usr/share/fonts/truetype/dejavu") / ("DejaVuSansMono.ttf" if mono else "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf")]
    return next((str(path) for path in candidates if path.is_file()), None)


@lru_cache(maxsize=256)
def font(size: int, bold: bool = False, mono: bool = False):
    path = font_file(bold, mono)
    return ImageFont.truetype(path, size) if path else ImageFont.load_default(size=size)


class Paint:
    def __init__(self, image: Image.Image, scale: float):
        self.image, self.draw, self.s = image, ImageDraw.Draw(image), scale

    def color(self, name: str) -> str:
        return COLORS.get(name, name)

    def rect(self, x, y, width, height, fill="surface", radius=0, outline=None):
        box = tuple(round(v * self.s) for v in (x, y, x + width, y + height))
        self.draw.rounded_rectangle(box, radius=max(0, round(radius * self.s)), fill=self.color(fill), outline=self.color(outline) if outline else None, width=max(1, round(self.s)))

    def line(self, points, color="border", width=1):
        self.draw.line([(round(x * self.s), round(y * self.s)) for x, y in points], fill=self.color(color), width=max(1, round(width * self.s)), joint="curve")

    def text(self, x, y, label, size=13, color="text", bold=False, mono=False, max_width=None):
        label = str(label)
        face = font(max(8, round(size * self.s)), bold, mono)
        if max_width:
            while len(label) > 1 and self.draw.textbbox((0, 0), label, font=face)[2] > max_width * self.s:
                label = label[:-2].rstrip("…") + "…"
        self.draw.text((round(x * self.s), round(y * self.s)), label, font=face, fill=self.color(color))

    def dot(self, x, y, radius=3, color="green"):
        self.draw.ellipse(tuple(round(v * self.s) for v in (x-radius, y-radius, x+radius, y+radius)), fill=self.color(color))

    def signal(self, x, y, size=20):
        # Lucide Radio's 24-unit signal silhouette, with rounded native strokes.
        unit = size / 24
        for radius in (6, 10):
            box = tuple(round(v * self.s) for v in (x+(12-radius)*unit, y+(12-radius)*unit, x+(12+radius)*unit, y+(12+radius)*unit))
            for start, end in ((-45, 45), (135, 225)):
                self.draw.arc(box, start, end, fill=self.color("accent"), width=max(1, round(2*unit*self.s)))
        self.draw.ellipse(tuple(round(v*self.s) for v in (x+10*unit,y+10*unit,x+14*unit,y+14*unit)), outline=self.color("accent"), width=max(1, round(2*unit*self.s)))

    def section(self, y, title, height):
        self.rect(15, y, 430, height, "inset", 8, "#252a34")
        self.text(27, y+10, title, 11, "secondary", True)

    def task(self, y, label, done, duration):
        self.rect(28, y+3, 12, 12, "green" if done else "raised", 3, "green" if done else "faint")
        if done:
            self.line([(31,y+9),(34,y+12),(38,y+6)], "inset", 1.5)
        self.text(49, y, label, 13, "secondary", max_width=285)
        self.text(354, y+1, duration, 11, "muted", mono=True)

    def chart(self, x, y, width, height, t, seed=0, color="accent"):
        for i in range(3):
            self.line([(x,y+i*height/2),(x+width,y+i*height/2)], "#252a34")
        values = [0.48 + 0.13*math.sin(i*.27+seed+t*.8) + 0.07*math.sin(i*.67-seed+t*.4) + .12*i/60 for i in range(61)]
        self.line([(x+i*width/60, y+height*(1-value)) for i,value in enumerate(values)], color, 2)


TITLES = [
    ("Investigate query latency", "Investigation", "active"),
    ("Implement cache boundary", "Coding", "active"),
    ("Verify the integration", "Validation", "active"),
    ("Review the request path", "Tracing", "active"),
    ("Hub monitoring", "Current installation", "active"),
    ("Publish review notes", "Evidence review", "completed"),
]


def card(index, scale, t, selected):
    image = Image.new("RGB", (round(460*scale*SS), round(380*scale*SS)), COLORS["canvas"])
    p = Paint(image, scale*SS)
    title, role, state = TITLES[index]
    p.rect(0, 0, 459, 379, "surface", 13, "accent" if selected else "border")
    p.line([(1,59),(458,59)], "#2a2f39")
    p.dot(20, 24, color="green" if state == "active" else "blue")
    p.text(33, 13, title, 15, bold=True)
    p.text(33, 35, role + " · " + state, 11, "muted")
    p.text(419, 18, "•••", 12, "muted")
    p.line([(1,354),(458,354)], "#2a2f39")
    p.text(16, 362, "COMPLETED" if state == "completed" else "LIVE", 10, "blue" if state == "completed" else "green")
    p.text(92, 362, "Synthetic work · local evidence", 10, "muted")
    if index == 0:
        p.section(73, "INVESTIGATION PLAN", 111)
        p.task(102, "Load the synthetic request samples", True, "1.234s")
        p.task(127, "Compare the slow response paths", t > 2.6, "2m 03s")
        p.task(152, "Validate the proposed boundary", t > 5.2, "4.812s" if t > 5.2 else "running")
        p.section(195, "QUERY · REPORTED RESULTS", 145)
        p.text(27, 223, "SELECT route, p95_ms FROM sample_requests", 11, "accent", mono=True)
        p.text(28, 250, "Route", 11, "muted")
        p.text(266, 250, "Before", 11, "muted")
        p.text(357, 250, "After", 11, "muted")
        for y, route, before, after in [(273,"/catalog",41,22),(296,"/search",36,18),(319,"/cart",29,17)]:
            p.text(28,y,route,12,mono=True)
            p.text(267,y,f"{before}ms",12,"secondary")
            p.text(357,y,f"{after}ms",12,"green")
    elif index == 1:
        p.section(73, "CHANGED FILES", 75)
        p.text(28,100,"src / CachePolicy.cs",13,"secondary",mono=True)
        p.text(28,123,"tests / CachePolicyTests.cs",13,"secondary",mono=True)
        p.section(159, "DIFF · PRESERVE REQUEST IDENTITY", 112)
        for j,(line,color) in enumerate([("  var entry = cache.Read(key);","secondary"),("- return entry.Value;","red"),("+ if (entry.IsFresh(now))","green"),("+     return entry.Value;","green")]):
            p.text(28,187+j*19,line,12,color,mono=True)
        p.section(282, "TEST RESULTS", 58)
        passed = 24 if t < 5 else 26
        p.text(28,307,f"{passed} passed",15,"green",True)
        p.text(180,309,"0 failed",12,"muted")
        p.text(300,309,"2 running" if t < 5 else "all complete",12,"accent")
    elif index == 2:
        p.section(73, "CONTRACT SUITE", 155)
        for y,label,done in [(101,"Replay concurrent reads",True),(128,"Preserve request identity",True),(155,"Reject stale writes",t>3),(182,"Retain selection during updates",t>6)]:
            p.dot(31,y+8,3,"green" if done else "yellow")
            p.text(44,y,label,13,"secondary",max_width=325)
            p.text(380,y+1,"pass" if done else "run",11,"green" if done else "yellow")
        p.section(239, "REPORTED LATENCY · ms", 101)
        p.chart(29,270,398,48,t,1)
        p.text(29,320,"12:04:10",10,"muted",mono=True)
        p.text(361,320,"12:04:40",10,"muted",mono=True)
    elif index == 3:
        p.section(73, "SERVICE MAP", 97)
        for x,label in [(28,"API"),(174,"Cache"),(320,"Store")]:
            p.rect(x,108,110,37,"raised",6,"border")
            p.dot(x+12,126,2.5)
            p.text(x+23,117,label,13,"secondary")
        p.text(147,115,"→",18,"muted")
        p.text(293,115,"→",18,"muted")
        p.section(181, "EXECUTION TRACE", 159)
        for y,label,width,offset in [(211,"Read request",355,0),(244,"Cache lookup",210,24),(277,"Shape response",96,210)]:
            p.text(28,y,label,12,"secondary")
            p.rect(28,y+20,398,6,"raised",3)
            p.rect(28+offset,y+20,width,6,"accent",3)
        p.text(28,320,"Reported duration  ·  42ms",11,"muted")
    elif index == 4:
        p.section(73,"ACCEPTED TRAFFIC",84)
        rate = 180 + round(32*math.sin(t*.8))
        for x,label,metric in [(28,"Active agents","6"),(160,"Updates /s",str(rate)),(310,"Payload /s",f"{48+round(6*math.sin(t))} KiB")]:
            p.text(x,98,label,11,"muted")
            p.text(x,119,metric,22,"text",True)
        p.section(168,"UPDATE RATE · LAST MINUTE",100)
        p.chart(28,197,398,45,t,2)
        p.text(28,248,"12:04:00",10,"muted",mono=True)
        p.text(362,248,"12:05:00",10,"muted",mono=True)
        p.section(279,"KIND INVENTORY",61)
        p.text(28,306,"metrics 12    logs 6    queries 4",12,"secondary",mono=True)
    else:
        p.section(73,"REVIEW SUMMARY",117)
        p.task(101,"Confirm the change against evidence",True,"8m 12s")
        p.task(128,"Retain the bounded validation report",True,"1.921s")
        p.task(155,"Prepare the review handoff",True,"3.451s")
        p.section(201,"COMPARISON",89)
        p.text(28,230,"Response p95",13,"secondary")
        p.text(245,230,"41ms   →   22ms",13,"green",mono=True)
        p.text(28,260,"Contracts",13,"secondary")
        p.text(245,260,"24     →   26",13,"green",mono=True)
        p.rect(330,308,96,28,"raised",6,"blue")
        p.text(351,313,"Archive",12,"blue",True)
    return image


def ease(value):
    value = max(0.0,min(1.0,value))
    return value*value*(3-2*value)


def camera(t):
    wide = (718,394,.60)
    keys = [(0,wide),(1.2,wide),(3.0,(340,187,1.10)),(4.2,(340,187,1.10)),(5.7,(695,187,1.10)),(6.5,(695,187,1.10)),(8.2,(718,598,1.10)),(9.7,(718,598,1.10)),(11.4,wide),(12,wide)]
    for (a,old),(b,new) in zip(keys,keys[1:]):
        if a <= t <= b:
            blend = ease((t-a)/(b-a))
            return tuple(x+(y-x)*blend for x,y in zip(old,new))
    return wide


def frame(t):
    image = Image.new("RGB",(W*SS,H*SS),COLORS["canvas"])
    p = Paint(image,SS)
    cx,cy,zoom = camera(t)
    # The grid remains a quiet background as the world camera moves.
    step = 26*zoom
    for col in range(-1,math.ceil(W/step)+1):
        for row in range(-1,math.ceil(H/step)+1):
            x=(col*step-cx*zoom)% (W+step)
            y=(row*step-cy*zoom)% (H+step)
            p.dot(x,y,.55,"#20252d")
    active = 0 if 2<t<4.7 else 1 if 4.7<=t<7 else 4 if 7<=t<10.7 else -1
    for i in range(6):
        x=(i%3)*488; y=(i//3)*408
        left=round((W/2+(x-cx)*zoom)*SS)
        top=round((310+(y-cy)*zoom)*SS)
        layer=card(i,zoom,t,i==active)
        image.paste(layer,(left,top))
    p=Paint(image,SS)
    p.rect(0,0,W,61,"canvas")
    p.line([(22,61),(978,61)],"#252a34")
    p.signal(24,18,23)
    p.text(58,16,"AgenticView",21,bold=True)
    p.text(202,24,"LOCAL",10,"muted",True)
    p.dot(738,30,3)
    p.text(749,21,"Connected · 6 agents",12,"secondary")
    p.rect(883,19,94,24,"raised",6,"border")
    p.text(893,23,"Synthetic demo",10,"secondary")
    p.rect(0,548,W,52,"canvas")
    p.rect(23,557,34,32,"surface",9,"border")
    # Cog-style settings mark and activity control mirror the native HUD.
    gear = []
    for i in range(32):
        angle = i * math.tau / 32
        radius = 9 if i % 4 in (1, 2) else 7
        gear.append((40 + radius * math.cos(angle), 573 + radius * math.sin(angle)))
    p.line(gear + [gear[0]], "secondary", 1.4)
    p.dot(40, 573, 3.2, "secondary")
    p.dot(40, 573, 1.8, "surface")
    p.rect(65,557,34,32,"surface",9,"border")
    p.line([(74,574),(78,574),(81,566),(85,581),(89,574),(92,574)],"accent",1.5)
    p.text(113,568,"Your workspace. Your focus.",11,"muted")
    p.rect(682,557,294,32,"surface",9,"border")
    p.text(696,562,"−",17,"secondary")
    p.text(727,566,f"{round(zoom*100)}%",12,"text",mono=True)
    p.text(781,562,"+",17,"secondary")
    p.line([(809,564),(809,583)],"border")
    p.text(824,566,"Fit all",12,"secondary")
    p.text(895,566,"Arrange all",12,"secondary")
    return image.resize((W,H),Image.Resampling.LANCZOS)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output",type=Path,default=ROOT/"docs/media/agenticview-demo.gif")
    parser.add_argument("--preview-dir",type=Path,help="Optional private directory for manual-review stills")
    parser.add_argument("--fps",type=int,choices=(8,9,10),default=8)
    args=parser.parse_args()
    args.output.parent.mkdir(parents=True,exist_ok=True)
    if args.preview_dir: args.preview_dir.mkdir(parents=True,exist_ok=True)
    first=frame(0)
    palette=first.quantize(colors=128,method=Image.Quantize.MEDIANCUT,dither=Image.Dither.NONE)
    frames=[]
    count=12*args.fps
    reviews={0:"wide",round(3.8*args.fps):"investigation",round(6.1*args.fps):"coding",round(9*args.fps):"monitoring"}
    for i in range(count):
        rendered=first if i==0 else frame(i/args.fps)
        if args.preview_dir and i in reviews: rendered.save(args.preview_dir/(reviews[i]+".png"))
        frames.append(rendered.quantize(palette=palette,dither=Image.Dither.NONE))
    duration=round(1000/args.fps/10)*10
    frames[0].save(args.output,save_all=True,append_images=frames[1:],duration=duration,loop=0,optimize=True,disposal=2)
    print(f"Synthetic illustration: {count} frames, {duration} ms/frame, {count*duration/1000:.2f}s; {args.output.stat().st_size/1024/1024:.2f} MiB")


if __name__=="__main__":
    main()
