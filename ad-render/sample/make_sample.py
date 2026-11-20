"""Generate the sample assets and brief.json for a local test render (no real photos or logos).

    python3 ad-render/sample/make_sample.py [--variant full|bare|longname]
    python3 ad-render/notice.py --brief ad-render/sample/brief.json

full      two photos, a logo, an example figure and a fee sentence, 5 lines (~38 s)
bare      no photos, no logo, no figure, no fee, 3 lines (L1, L2, L5)
longname  as full, with a very long company name
Assets are gradients and soft shapes made with Pillow; the voice is a quiet generated tone.
"""
import argparse
import json
import os
import random
import subprocess

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
DURATION = 38.0

LINES = [
    "Has your tenant handed in their notice? We're {company}, and before your agent lines up the next one, there's another way to let it.",
    "It's a short-term let, like an Airbnb. Guests book a few nights at a time, and we run it all for you in {area}.",
    "Here's a typical example: a two-bed in {area} could take home about one thousand eight hundred and fifty pounds a month, after every cost.",
    "And when guests check out, there's no tenancy to get stuck in. You stay the owner. {fee}",
    "So while they're working out their notice, have a look at our website. It takes about a minute, and there's no commitment.",
]
FIG_LABEL = "Example: a typical 2-bed in {area}, from 14 reports. Every property is different."


def photo(path, seed, c1, c2, size=(1600, 1000)):
    rnd = random.Random(seed)
    w, h = size
    im = Image.new("RGB", size)
    px = ImageDraw.Draw(im)
    for y in range(h):
        k = y / h
        px.line([(0, y), (w, y)], fill=tuple(int(c1[i] + (c2[i] - c1[i]) * k) for i in range(3)))
    d = ImageDraw.Draw(im)
    for _ in range(14):
        x, y, r = rnd.randint(0, w), rnd.randint(0, h), rnd.randint(80, 320)
        col = tuple(rnd.randint(60, 230) for _ in range(3))
        d.ellipse((x - r, y - r // 2, x + r, y + r // 2), fill=col)
    im = im.filter(ImageFilter.GaussianBlur(40))
    im.save(path, quality=72)


def logo(path):
    im = Image.new("RGBA", (360, 160), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((10, 10, 150, 150), radius=30, fill=(30, 90, 150, 255))
    d.polygon([(40, 110), (80, 45), (120, 110)], fill=(255, 255, 255, 255))
    d.rectangle((170, 60, 340, 78), fill=(30, 90, 150, 255))
    d.rectangle((170, 92, 300, 110), fill=(120, 160, 200, 255))
    im.save(path)


def voice(path):
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"sine=frequency=180:duration={DURATION}",
           "-af", "volume=0.05,tremolo=f=3:d=0.6", "-ac", "1", "-b:a", "48k", path]
    subprocess.run(cmd, check=True)


def spoken(text):
    return [w for w in text.split() if w]


def build(variant):
    company = "Harbour & Pine Lettings"
    if variant == "longname":
        company = "The Northern Counties Short Stay Management and Holiday Letting Company Limited"
    area = "Northfield"
    fee = "Our management fee is 12%."
    figure = variant != "bare"
    with_fee = variant != "bare"
    texts = []
    for i, t in enumerate(LINES):
        if i == 2 and not figure:
            t = "It only takes a minute to find out what yours could take home."
        texts.append(t.format(company=company, area=area, fee=fee if with_fee else "").strip())
    ids = ["L1", "L2", "L3", "L4", "L5"]
    if variant == "bare":
        keep = [0, 1, 4]
    else:
        keep = [0, 1, 2, 3, 4]
    allw = [(ids[i], w) for i in keep for w in spoken(texts[i])]
    step = (DURATION - 1.0) / len(allw)
    words, line_t = [], {}
    for k, (lid, w) in enumerate(allw):
        s, e = 0.3 + k * step, 0.3 + k * step + step * 0.85
        words.append({"text": w, "start": round(s, 2), "end": round(e, 2)})
        line_t.setdefault(lid, [s, e])[1] = e
    lines = [{"id": ids[i], "text": texts[i], "start": round(line_t[ids[i]][0], 2), "end": round(line_t[ids[i]][1], 2)}
             for i in keep]
    brief = {
        "version": 1,
        "brand": {"company": company, "colour": "#1F5F8B", "logo": None if variant == "bare" else "logo.png"},
        "photos": [] if variant == "bare" else ["photo1.jpg", "photo2.jpg"],
        "area": area,
        "bedrooms": 2,
        "figure": None if not figure else {
            "label": FIG_LABEL.format(area=area),
            "sentence": texts[2],
            "gross": 2650, "net": 2050, "takeHome": 1850, "occupancyPct": 68, "basis": "take-home",
        },
        "fee_sentence": fee if with_fee else None,
        "script": {"lines": lines, "words": words, "duration": DURATION},
        "audio": "voice.mp3",
        "out_dir": "out",
    }
    return brief


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--variant", default="full", choices=["full", "bare", "longname"])
    ap.add_argument("--out", default=HERE)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    photo(os.path.join(args.out, "photo1.jpg"), 1, (40, 70, 110), (200, 170, 120))
    photo(os.path.join(args.out, "photo2.jpg"), 2, (230, 220, 200), (70, 110, 90), (1200, 1600))
    logo(os.path.join(args.out, "logo.png"))
    voice(os.path.join(args.out, "voice.mp3"))
    with open(os.path.join(args.out, "brief.json"), "w", encoding="utf-8") as fh:
        json.dump(build(args.variant), fh, indent=2)


if __name__ == "__main__":
    main()
