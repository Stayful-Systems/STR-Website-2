"""Shared parts of the two lead database videos (report_walk.py and loupe.py), brief version 2.

The base is white or the report's cream (#F5F4ED), never the brand colour full-bleed. The brand colour is used for
four things only: the logo strip, the headline bar, the caption highlight and the end button. Key content sits between
y=270 and y=1250 of the 9:16 frame, so the 4:5 and 1:1 crops (video.pick_crops) hold all of it; they are cut from the
9:16 frame, whose background is the ad's own solid base, so nothing is ever blurred to fill a gap. Captions, the voice
and the encode come from notice.py and video.py unchanged (imported, not copied).
"""
import json
import os

from PIL import Image, ImageDraw

import components as comp
import theme
from notice import build_pages, page_windows
from theme import font
from video import Canvas, H, W, RenderError, has_audio, measure_extent, pick_crops, probe_duration, prog, ease_out, render_all

# The 9:16 bands (px).
STRIP_Y, STRIP_H = 276, 96
BAR_Y = 392                     # headline bar top
CONTENT_TOP, CONTENT_BOTTOM = 590, 1100
CAP_BOTTOM = 1250
PAD_X = 60
CARD_MAX_W = 960
LEAD = 0.12
OUT_SIZES = ("9x16", "4x5", "1x1")
BASES = ("#F5F4ED", "#FFFFFF")


def bad():
    raise RenderError("bad_brief")


def safe_rel(p):
    if not isinstance(p, str) or not p or len(p) > 400 or p.startswith("/") or "\\" in p or ":" in p:
        return False
    return all(seg not in ("", ".", "..") for seg in p.split("/"))


def load_brief_v2(path, fmt):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            b = json.load(fh)
    except (OSError, ValueError):
        bad()
    if not isinstance(b, dict) or b.get("version") != 2 or b.get("format") != fmt:
        bad()
    brand = b.get("brand") or {}
    rgb = theme.parse_hex(brand.get("colour"))
    if rgb is None or not isinstance(brand.get("company"), str) or not brand["company"].strip():
        bad()
    if b.get("base") not in BASES:
        bad()
    lines = b.get("screen_lines")
    if not isinstance(lines, list) or len(lines) != 5 or not all(isinstance(x, str) and x.strip() for x in lines):
        bad()
    pages = b.get("report_pages")
    if not isinstance(pages, list) or not pages or not all(safe_rel(p) for p in pages):
        bad()
    logo = brand.get("logo")
    if logo is not None and not safe_rel(logo):
        bad()
    script = b.get("script") or {}
    if not isinstance(script.get("words"), list) or not isinstance(script.get("lines"), list) or not script["lines"]:
        bad()
    if not isinstance(b.get("stamp"), str) or not b["stamp"]:
        bad()
    for k in ("audio", "out_dir"):
        if not safe_rel(b.get(k)):
            bad()
    if b.get("out_prefix") not in ("phone", "loupe"):
        bad()
    b["rgb"] = rgb
    b["base_rgb"] = theme.parse_hex(b["base"])
    return b


def resolver(brief_path):
    base = os.path.dirname(os.path.abspath(brief_path))

    def resolve(rel):
        return os.path.join(base, rel)

    return resolve


# ------------------------------------------------------------------ pure helpers (tested)
def scene_times(script_lines, dur, n=5):
    """Start time of each of the n scenes: the first at 0, the last at the last spoken line (the CTA), the middle ones
    at their own spoken line when there is one, else spread evenly between the first and the last line."""
    starts = [max(0.0, float(l["start"]) - LEAD) for l in script_lines]
    if not starts:
        return [dur * i / n for i in range(n)]
    out = [0.0]
    last = starts[-1] if len(starts) > 1 else dur * (n - 1) / n
    if len(starts) == n:
        out += starts[1:]
    else:
        a = starts[1] if len(starts) > 2 else dur / n
        for i in range(1, n - 1):
            out.append(a + (last - a) * (i - 1) / max(1, n - 2))
        out.append(last)
    # strictly increasing
    for i in range(1, len(out)):
        out[i] = max(out[i], out[i - 1] + 0.4)
    return out


def fit_rect(src_w, src_h, box_w, box_h):
    """The largest (w, h) of the source's shape inside the box (scale down only as needed; never stretched)."""
    if src_w <= 0 or src_h <= 0:
        return 0, 0
    k = min(box_w / src_w, box_h / src_h)
    return max(1, int(src_w * k)), max(1, int(src_h * k))


def palette_v2(rgb, base_rgb):
    """The two videos' colours: the base for the ground, the brand only for strip, bar, highlight and button."""
    tc = theme.pick_text(rgb)
    on_base = theme.pick_text(base_rgb)
    t = theme.derive_tints(rgb)
    mark = rgb if theme.contrast(rgb, (255, 255, 255)) >= 2.0 else t["deep"]
    return {
        "base": tuple(base_rgb),
        "brand": tuple(rgb),
        "brand_text": tc,
        "ink": on_base,
        "plate": (255, 255, 255) if base_rgb != (255, 255, 255) else (240, 240, 236),
        "panel_text": theme.TEXT_ON_LIGHT,
        "mark": mark,
        "mark_text": theme.pick_text(mark),
        "strip": tuple(rgb) + (255,),
    }


# ------------------------------------------------------------------ sprites
def rounded_card(img, width, height, radius=34, border=(0, 0, 0, 28)):
    """An image whole inside a rounded white card of exactly (width, height); the image is scaled to fit, never cut."""
    card = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    mask = Image.new("L", (width, height), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, width - 1, height - 1), radius=radius, fill=255)
    inner = Image.new("RGBA", (width, height), (255, 255, 255, 255))
    w, h = fit_rect(img.width, img.height, width, height)
    inner.paste(img.convert("RGB").resize((w, h), Image.LANCZOS), ((width - w) // 2, (height - h) // 2))
    card.paste(inner, (0, 0), mask)
    ImageDraw.Draw(card).rounded_rectangle((0, 0, width - 1, height - 1), radius=radius, outline=border, width=2)
    return card


def page_card(page, box_w=CARD_MAX_W, box_h=CONTENT_BOTTOM - CONTENT_TOP):
    w, h = fit_rect(page.width, page.height, box_w, box_h)
    return rounded_card(page, w, h)


def stamp_sprite(text, pal, size=34):
    f = font("semi", size)
    tw = int(f.getlength(text))
    padx, pady = 22, 12
    asc, dsc = f.getmetrics()
    spr = Image.new("RGBA", (tw + padx * 2, asc + dsc + pady * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(spr)
    d.rounded_rectangle((0, 0, spr.width - 1, spr.height - 1), radius=spr.height // 2, fill=(17, 17, 17, 230))
    d.text((padx, pady), text, font=f, fill=(255, 255, 255, 255))
    return spr


def headline_bar(text, pal, width=W - 2 * PAD_X):
    """The headline on a solid brand-colour bar (the frame-one offer and each scene line)."""
    lines, size, lhp, ok = theme.fit(text, "semi", width - 64, 2, 56, 34, 1.1)
    spr = comp.text_block(lines, "semi", size, pal["brand_text"], lhp)
    h = spr.height + 44
    bar = Image.new("RGBA", (width, h), (0, 0, 0, 0))
    ImageDraw.Draw(bar).rounded_rectangle((0, 0, width - 1, h - 1), radius=28, fill=pal["brand"] + (255,))
    bar.alpha_composite(spr, (26, (h - spr.height) // 2))
    return bar


def logo_strip(pal, logo, company):
    return comp.brand_strip(pal["strip"], W - 2 * PAD_X, logo=logo, company=company, text_colour=pal["brand_text"], height=STRIP_H)


def cta_block(pal, company, logo, cta):
    btn = comp.pill(cta, "semi", 56, pal["brand_text"], pal["brand"])
    name = comp.fitted_text(company, "semi", pal["ink"], W - 2 * PAD_X, 2, 60, 40, 1.12)
    owner = comp.fitted_text("You stay the owner.", "med", pal["ink"], W - 2 * PAD_X, 1, 44, 34, 1.1)
    parts = [p for p in (logo, name, btn, owner) if p is not None]
    return comp.vstack(parts, gap=36, align="center", width=W - 2 * PAD_X)


def phone_shell(screen, height):
    """A plain phone around a drawn screen: a dark rounded body, the screen inset, nothing else."""
    sw, sh = fit_rect(screen.width, screen.height, int(height * 0.462), height - 28)
    body_w, body_h = sw + 28, sh + 28
    body = Image.new("RGBA", (body_w, body_h), (0, 0, 0, 0))
    ImageDraw.Draw(body).rounded_rectangle((0, 0, body_w - 1, body_h - 1), radius=56, fill=(24, 24, 27, 255))
    mask = Image.new("L", (sw, sh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, sw - 1, sh - 1), radius=44, fill=255)
    body.paste(screen.convert("RGB").resize((sw, sh), Image.LANCZOS), (14, 14), mask)
    return body


def background(pal):
    return Image.new("RGB", (W, H), pal["base"])


def first_frame_stats(img):
    """The picture measure the gate reads (ld-gate.ts): a 4-bin per channel histogram and a 32x32 grey thumbnail."""
    small = img.convert("RGB").resize((64, 114), Image.BILINEAR)
    hist = [0] * 64
    px = list(small.getdata())
    for r, g, b in px:
        hist[min(3, r // 64) * 16 + min(3, g // 64) * 4 + min(3, b // 64)] += 1
    n = float(len(px))
    thumb = list(img.convert("L").resize((32, 32), Image.BILINEAR).getdata())
    return {"hist": [round(v / n, 5) for v in hist], "thumb": thumb}


# ------------------------------------------------------------------ the shared pipeline
def captions(brief, pal, dur):
    cpal = {"plate": pal["plate"], "panel_text": pal["panel_text"], "mark": pal["mark"], "mark_text": pal["mark_text"]}
    pages = build_pages(brief["script"]["words"], cpal)
    return pages, page_windows(pages, dur)


def drawers(scene_draw, pages, wins):
    """frame(t) and extent(t) from a scene drawer (cv, t) plus the captions."""

    def draw_into(cv, t):
        scene_draw(cv, t)
        for p, (a, b) in zip(pages, wins):
            if a <= t < b:
                y = CAP_BOTTOM - p.sprite.height
                x = (W - p.sprite.width) // 2
                cv.put(p.sprite, x, y)
                cur = 0
                for j, w in enumerate(p.words):
                    if w["start"] <= t:
                        cur = j
                mk, dx, dy = p.marks[cur]
                cv.put(mk, x + dx, y + dy)
                break

    def frame(t, base_img):
        cv = Canvas(base_img.copy())
        draw_into(cv, t)
        return cv.im

    def extent(t):
        cv = Canvas(None)
        draw_into(cv, t)
        return cv.box

    return frame, extent


def encode(brief, resolve, build):
    """build(brief, resolve, dur, pal) -> (scene_draw, scene_ids). Writes the three MP4s, poster, first frame, info."""
    audio = resolve(brief["audio"])
    out_dir = resolve(brief["out_dir"])
    if not os.path.isfile(audio):
        raise RenderError("missing_asset")
    for style in theme.FONT_FILES:
        try:
            font(style, 20)
        except theme.FontMissing:
            raise RenderError("missing_asset")
    if not has_audio(audio):
        raise RenderError("ffmpeg_failed")
    dur = min(probe_duration(audio), 180.0)
    os.makedirs(out_dir, exist_ok=True)
    pal = palette_v2(brief["rgb"], brief["base_rgb"])
    scene_draw, scene_ids = build(brief, resolve, dur, pal)
    pages, wins = captions(brief, pal, dur)
    frame_with, extent = drawers(scene_draw, pages, wins)
    bg = background(pal)

    def frame(t):
        return frame_with(t, bg)

    y0, y1 = measure_extent(extent, dur)
    if y0 < 270 or y1 > 1250 + 40 or y1 - y0 > 1080 - 80:
        raise RenderError("render_failed")
    crops = pick_crops((y0, y1))
    prefix = brief["out_prefix"]
    outs = {k: os.path.join(out_dir, "%s_%s.mp4" % (prefix, k)) for k in OUT_SIZES}
    n = int(round(dur * 30))
    render_all(frame, n, audio, outs, n / 30.0, crops)
    first = frame(0.4)
    first.save(os.path.join(out_dir, "first-frame.png"))
    frame(min(2.0, dur / 2)).save(os.path.join(out_dir, "poster.png"))
    with open(os.path.join(out_dir, "render-info.json"), "w", encoding="utf-8") as fh:
        json.dump({"captions": len(pages), "scenes": scene_ids, "duration": round(n / 30.0, 2), "first_frame": first_frame_stats(first), "crops": crops}, fh)
    return crops


def ease_in_scene(t, t0, d=0.4):
    return ease_out(prog(t, t0, t0 + d))


def lens(page, target, scale=1.9, out_w=860, out_h=300):
    """The magnifier: the target region of the page enlarged into a rounded lens with a brand ring."""
    x0 = int(target["x"] * page.width)
    y0 = int(target["y"] * page.height)
    x1 = int((target["x"] + target["w"]) * page.width)
    y1 = int((target["y"] + target["h"]) * page.height)
    region = page.crop((x0, y0, max(x0 + 1, x1), max(y0 + 1, y1))).convert("RGB")
    w, h = fit_rect(region.width, region.height, out_w, out_h)
    w, h = min(out_w, int(w)), min(out_h, int(h))
    return region.resize((max(1, w), max(1, h)), Image.LANCZOS)


def clamp01(x):
    return 0.0 if x < 0 else 1.0 if x > 1 else x

