"""Notice video: a 9:16 ad (plus 4:5 and 1:1 crops of it) in the operator's own brand.

    python3 notice.py --brief <path to brief.json>

Everything comes from the brief (see README.md for the schema). Paths in the brief are relative to
the folder the brief sits in. Output goes to brief.out_dir: notice_9x16.mp4, notice_4x5.mp4,
notice_1x1.mp4 and poster.png. On failure: one line `ERR <code>` on stderr and a non-zero exit;
nothing from the brief is ever printed.

Scenes follow the five script lines: L1 hook, L2 the short-term-let idea, L3 the labelled example
(or a plain line when there is no figure), L4 "no tenancy, you stay the owner" (+ the fee sentence),
L5 the website call to action. A missing line drops its scene; 3 to 5 lines are fine.
"""
import argparse
import bisect
import json
import math
import os
import re
import sys

from PIL import Image, ImageDraw, ImageOps

import components as comp
import theme
from theme import font
from video import (Canvas, H, W, RenderError, SAFE_BOTTOM, SAFE_TOP, ease_io, ease_out, has_audio,
                   measure_extent, pick_crops, probe_duration, prog, render_all)

# The content band (9:16 px). Tighter than the safe area so the 1:1 crop (1080 tall) holds everything.
STRIP_Y, STRIP_H = 320, 104
CT, CB = 452, 1090            # scene content sits between these
CAP_BOTTOM = 1280             # captions end here
PAD_X = 80
BW = W - PAD_X * 2            # 920, width of every text box
CAP_SIZE, CAP_MAX_CHARS = 54, 28
LEAD = 0.12                   # a scene starts this long before its line is spoken
OUT_NAMES = {"9x16": "notice_9x16.mp4", "4x5": "notice_4x5.mp4", "1x1": "notice_1x1.mp4"}
BASIS_UNIT = {"take-home": "a month, take-home", "net": "a month, after costs", "gross": "a month in bookings"}
BASIS_KEY = {"take-home": "takeHome", "net": "net", "gross": "gross"}
LINE_IDS = ("L1", "L2", "L3", "L4", "L5")


# ------------------------------------------------------------------ brief
def _bad():
    raise RenderError("bad_brief")


def _num(v, lo=None, hi=None):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        _bad()
    if (lo is not None and v < lo) or (hi is not None and v > hi):
        _bad()
    return float(v)


def _opt_int(v):
    if v is None:
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        _bad()
    return int(round(v))


def _str(v, max_len=2000, allow_empty=False):
    if not isinstance(v, str) or len(v) > max_len or (not allow_empty and not v.strip()):
        _bad()
    return v


def load_brief(path):
    try:
        with open(path, "rb") as fh:
            raw = fh.read(2_000_000)
        b = json.loads(raw.decode("utf-8"))
    except (OSError, ValueError):
        raise RenderError("bad_brief")
    if not isinstance(b, dict) or b.get("version") != 1:
        _bad()
    brand = b.get("brand")
    if not isinstance(brand, dict):
        _bad()
    rgb = theme.parse_hex(brand.get("colour"))
    if rgb is None:
        _bad()
    out = {
        "company": theme.clean(_str(brand.get("company"), 200), 80),
        "rgb": rgb,
        "logo": None if brand.get("logo") is None else _str(brand.get("logo"), 400),
    }
    if not out["company"]:
        _bad()
    photos = b.get("photos")
    if not isinstance(photos, list) or len(photos) > 4:
        _bad()
    out["photos"] = [_str(p, 400) for p in photos]
    out["area"] = theme.clean(_str(b.get("area", ""), 200, allow_empty=True), 40)
    out["bedrooms"] = _opt_int(b.get("bedrooms"))
    fig = b.get("figure")
    if fig is None:
        out["figure"] = None
    else:
        if not isinstance(fig, dict):
            _bad()
        basis = fig.get("basis")
        if basis not in BASIS_KEY:
            _bad()
        out["figure"] = {
            "label": _str(fig.get("label"), 600),
            "sentence": _str(fig.get("sentence", ""), 1200, allow_empty=True),
            "basis": basis,
            "gross": _opt_int(fig.get("gross")),
            "net": _opt_int(fig.get("net")),
            "takeHome": _opt_int(fig.get("takeHome")),
            "occupancyPct": _opt_int(fig.get("occupancyPct")),
        }
    fee = b.get("fee_sentence")
    out["fee"] = None if fee is None else (theme.clean(_str(fee, 300, allow_empty=True), 140) or None)
    sc = b.get("script")
    if not isinstance(sc, dict):
        _bad()
    lines = sc.get("lines")
    if not isinstance(lines, list) or not (3 <= len(lines) <= 5):
        _bad()
    seen, last = [], -1.0
    out["lines"] = []
    for ln in lines:
        if not isinstance(ln, dict) or ln.get("id") not in LINE_IDS or ln["id"] in seen:
            _bad()
        seen.append(ln["id"])
        start, end = _num(ln.get("start"), 0, 600), _num(ln.get("end"), 0, 600)
        if start < last or end < start:
            _bad()
        last = start
        out["lines"].append({"id": ln["id"], "start": start, "end": end})
    words = sc.get("words")
    if not isinstance(words, list) or len(words) > 600:
        _bad()
    out["words"] = []
    for w in words:
        if not isinstance(w, dict):
            _bad()
        text = theme.clean(_str(w.get("text"), 80, allow_empty=True))
        start, end = _num(w.get("start"), 0, 600), _num(w.get("end"), 0, 600)
        if end < start:
            _bad()
        if text:
            out["words"].append({"text": text, "start": start, "end": end})
    out["duration"] = _num(sc.get("duration"), 1, 180)
    out["audio"] = _str(b.get("audio"), 400)
    out["out_dir"] = _str(b.get("out_dir"), 400)
    return out


def resolver(brief_path):
    """Map a path from the brief to a real path inside the brief's own folder, or bad_brief."""
    base = os.path.realpath(os.path.dirname(os.path.abspath(brief_path)))

    def resolve(rel):
        if not rel or "\x00" in rel or os.path.isabs(rel):
            _bad()
        p = os.path.realpath(os.path.join(base, rel))
        if os.path.commonpath([base, p]) != base:
            _bad()
        return p
    return resolve


# ------------------------------------------------------------------ photos and backgrounds
class Photos:
    """Operator photos: cover-scaled once, darkened once per overlay, Ken-Burns windows per scene."""

    def __init__(self, paths, overlay_rgb, alpha):
        self.paths, self.overlay, self.alpha = paths, overlay_rgb, alpha
        self.cover = {}
        self.dark = {}

    def _cover(self, i):
        if i not in self.cover:
            try:
                im = Image.open(self.paths[i])
                im.draft("RGB", (W * 2, H * 2))
                im = ImageOps.exif_transpose(im).convert("RGB")
            except Exception:
                raise RenderError("missing_asset")
            k = max(W * 1.25 / im.width, H * 1.25 / im.height)
            self.cover[i] = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.LANCZOS)
        return self.cover[i]

    def window(self, i, fx):
        """A 1350x2400 darkened crop of photo i around horizontal focus fx (0..1)."""
        key = (i, round(fx, 2))
        if key not in self.dark:
            big = self._cover(i)
            cw, ch = round(W * 1.25), round(H * 1.25)
            x0 = int(max(0, min(big.width - cw, big.width * fx - cw / 2)))
            y0 = int(max(0, (big.height - ch) / 2))
            crop = big.crop((x0, y0, x0 + cw, y0 + ch))
            solid = Image.new("RGB", crop.size, tuple(self.overlay))
            self.dark[key] = Image.blend(crop, solid, self.alpha)
        return self.dark[key]


def solid_background(rgb, tc):
    """A solid brand-tint field with two faint circles of the type colour for depth."""
    im = Image.new("RGB", (W, H), tuple(rgb))
    lay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    fill = tuple(tc) + (22,)
    d.ellipse((W - 380, 420 - 420, W + 520, 420 + 480), fill=fill)
    d.ellipse((-460, 1180, 420, 2060), fill=fill)
    im.paste(lay, (0, 0), lay)
    return im


class Scene:
    def __init__(self, sid, t0, t1, tc, dip_rgb, strip, bg_img=None, photo=None):
        self.id, self.t0, self.t1, self.tc, self.dip_rgb = sid, t0, t1, tc, dip_rgb
        self.strip, self.bg_img, self.photo = strip, bg_img, photo   # photo = (Image 1350x2400, pan seed)
        self.items = []      # (sprite, x, y, delay)

    def add(self, spr, x, y, delay=0.0):
        self.items.append((spr, x, y, delay))

    def draw(self, cv, t):
        if cv.im is not None:
            if self.photo is not None:
                src, pan = self.photo
                k = ease_io(prog(t, self.t0, self.t1 + 0.5))
                s = 1.22 - 0.12 * k                     # window size in source px per frame px
                vw, vh = W * s, H * s
                sx, sy = src.width - vw, src.height - vh
                px = (0.25 + 0.5 * k) if pan else (0.75 - 0.5 * k)
                x0, y0 = sx * px, sy * (0.35 + 0.3 * k)
                cv.im = src.resize((W, H), Image.BILINEAR, box=(x0, y0, x0 + vw, y0 + vh))
            else:
                cv.im = self.bg_img.copy()
            dip = 0.5 * (1 - prog(t, self.t0, self.t0 + 0.22))
            if dip > 0.02:
                cv.im = Image.blend(cv.im, Image.new("RGB", (W, H), tuple(self.dip_rgb)), dip)
        if self.strip is not None:
            cv.put(self.strip, PAD_X, STRIP_Y)
        for spr, x, y, delay in self.items:
            k = prog(t, self.t0 + delay, self.t0 + delay + 0.4)
            e = ease_out(k)
            cv.put(spr, x, y + 34 * (1 - e), e)


# ------------------------------------------------------------------ captions
class Page:
    def __init__(self, words, lines, size):
        self.words, self.lines, self.size = words, lines, size
        self.t0 = words[0]["start"]
        self.t1 = words[-1]["end"]
        self.sprite = None
        self.marks = []       # per word: (sprite, dx, dy) highlight, relative to the page sprite


def _group_words(words):
    """Pages of at most 2 lines of ~28 characters; a page also ends at a sentence end."""
    pages, cur = [], None
    for w in words:
        if cur is None:
            cur = [[w]]
        else:
            n = sum(len(x["text"]) for x in cur[-1]) + len(cur[-1]) - 1 + 1 + len(w["text"])
            if n <= CAP_MAX_CHARS:
                cur[-1].append(w)
            elif len(cur) < 2:
                cur.append([w])
            else:
                pages.append(cur)
                cur = [[w]]
        if re.search(r"[.?!]$", w["text"]):
            pages.append(cur)
            cur = None
    if cur:
        pages.append(cur)
    return pages


def build_pages(words, pal):
    max_w = W - 2 * 40
    padx, pady = 34, 20
    pages = []
    for grp in _group_words(words):
        size = CAP_SIZE
        while True:
            f = font("semi", size)
            widths = [f.getlength(" ".join(x["text"] for x in ln)) for ln in grp]
            if max(widths) + padx * 2 <= max_w or size <= 34:
                break
            size -= 2
        lhp = int(size * 1.22)
        asc, dsc = f.getmetrics()
        pw = int(max(widths)) + padx * 2
        ph = lhp * (len(grp) - 1) + asc + dsc + pady * 2
        spr = Image.new("RGBA", (pw, ph), (0, 0, 0, 0))
        d = ImageDraw.Draw(spr)
        d.rounded_rectangle((0, 0, pw - 1, ph - 1), radius=30, fill=tuple(pal["plate"]) + (240,))
        flat = [w for ln in grp for w in ln]
        page = Page(flat, grp, size)
        space = f.getlength(" ")
        for li, ln in enumerate(grp):
            x = (pw - widths[li]) / 2
            base = pady + asc + li * lhp
            for w in ln:
                d.text((x, base), w["text"], font=f, fill=tuple(pal["panel_text"]) + (255,), anchor="ls")
                wl = f.getlength(w["text"])
                mk = Image.new("RGBA", (int(wl) + 14, asc + dsc + 4), (0, 0, 0, 0))
                md = ImageDraw.Draw(mk)
                md.rounded_rectangle((0, 0, mk.width - 1, mk.height - 1), radius=14, fill=tuple(pal["mark"]) + (255,))
                md.text((7, asc + 2), w["text"], font=f, fill=tuple(pal["mark_text"]) + (255,), anchor="ls")
                page.marks.append((mk, x - 7, base - asc - 2))
                x += wl + space
        page.sprite = spr
        pages.append(page)
    return pages


def page_windows(pages, dur):
    """(show_from, show_until) per page: held until the next page unless the speaker pauses."""
    out = []
    for i, p in enumerate(pages):
        end = p.t1 + 0.3
        if i + 1 < len(pages):
            nxt = pages[i + 1].t0
            end = nxt if nxt - p.t1 < 0.7 else min(end, nxt)
        out.append((max(0.0, p.t0 - 0.04), min(dur, end)))
    return out


# ------------------------------------------------------------------ build
def build(brief, resolve, audio_dur):
    pal = theme.palette_for(brief["rgb"])
    tints = pal["tints"]
    text = pal["text"]
    oa = theme.overlay_alpha(pal["overlay"], text)

    logo = None
    if brief["logo"]:
        lp = resolve(brief["logo"])
        if not os.path.isfile(lp):
            raise RenderError("missing_asset")
        try:
            logo = comp.load_logo(lp)
        except Exception:
            raise RenderError("missing_asset")
    photo_paths = []
    for p in brief["photos"]:
        pp = resolve(p)
        if not os.path.isfile(pp):
            raise RenderError("missing_asset")
        photo_paths.append(pp)
    photos = Photos(photo_paths, pal["overlay"], oa) if photo_paths else None

    # scene times: each line's scene runs until the next one starts
    lines = brief["lines"]
    starts = [0.0]
    for ln in lines[1:]:
        starts.append(max(starts[-1] + 0.6, ln["start"] - LEAD))
    ends = starts[1:] + [audio_dur]

    n_photo_scenes = [0]

    def photo_for(role, fx):
        """Photo background (Image, pan) for a scene role, cycling the operator's photos."""
        if photos is None:
            return None
        i = n_photo_scenes[0]
        n_photo_scenes[0] += 1
        return photos.window(i % len(photo_paths), fx), (i % 2 == 0)

    def strip_for(tc, with_company=True):
        fill = (255, 255, 255, 40) if tc == theme.TEXT_ON_DARK else (0, 0, 0, 34)
        if not with_company and logo is None:
            return None
        return comp.brand_strip(fill, BW, logo, brief["company"] if with_company else None, tc, STRIP_H)

    def centred(sprites, gap):
        total = sum(s.height for s in sprites) + gap * (len(sprites) - 1)
        y = CT + max(0, (CB - CT - total) // 2)
        out = []
        for s in sprites:
            out.append(y)
            y += s.height + gap
        return out, total

    scenes = []
    fig = brief["figure"]
    solid_cycle = [tints["base"], tints["dark"], tints["deep"], tints["base"], tints["dark"]]
    for idx, ln in enumerate(lines):
        sid, t0, t1 = ln["id"], starts[idx], ends[idx]
        spec = None
        # role of the scene: photo or solid, and which solid tint
        if sid in ("L1", "L2", "L4") and photos is not None:
            spec = photo_for(sid, {"L1": 0.5, "L2": 0.3, "L4": 0.7}[sid])
        elif sid == "L5" and photos is not None and len(photo_paths) >= 4:
            spec = photo_for(sid, 0.5)
        if spec is not None:
            tc, surf = text, tints["base"]
            sc = Scene(sid, t0, t1, tc, pal["overlay"], strip_for(tc, sid != "L1"), photo=spec)
        else:
            if sid == "L3" or sid == "L5":
                surf = tints["base"]
            else:
                surf = {"L1": tints["base"], "L2": tints["dark"], "L4": tints["deep"]}[sid]
            tc = theme.surface_text(surf)
            sc = Scene(sid, t0, t1, tc, surf, strip_for(tc, sid != "L1"), bg_img=solid_background(surf, tc))
        inv = theme.pick_text(tc)     # colour of type set on a bar filled with tc

        if sid == "L1":
            bar = comp.accent_bar(tc)
            head = comp.fitted_text("Has your tenant handed in their notice?", "head", tc, BW, 4, 150, 84, 1.08, True, max_h=380)
            sub = comp.fitted_text("We're " + brief["company"], "semi", tc, BW, 3, 64, 40, 1.15, max_h=170)
            sprites = [bar, head, sub]
            ys, _ = centred(sprites, 28)
            for s, y, d in zip(sprites, ys, (0.0, 0.05, 0.45)):
                sc.add(s, PAD_X, y, d)
        elif sid == "L2":
            bar = comp.accent_bar(tc)
            head = comp.fitted_text("A short-term let, like an Airbnb.", "head", tc, BW, 3, 140, 80, 1.08, True, max_h=330)
            run = "We run it all for you in " + brief["area"] + "." if brief["area"] else "We run it all for you."
            sub = comp.vstack([comp.fitted_text("Guests book a few nights at a time.", "semi", tc, BW, 2, 56, 44, 1.15),
                               comp.fitted_text(run, "semi", tc, BW, 2, 56, 44, 1.15)], gap=10)
            sprites = [bar, head, sub]
            ys, _ = centred(sprites, 28)
            for s, y, d in zip(sprites, ys, (0.0, 0.05, 0.4)):
                sc.add(s, PAD_X, y, d)
        elif sid == "L3" and fig is not None:
            value = fig[BASIS_KEY[fig["basis"]]]
            big = comp.money(value) if value is not None else None
            extra = "Typical occupancy: %d%%" % fig["occupancyPct"] if (fig["occupancyPct"] is not None and big) else None
            panel = comp.figure_panel(pal, BW, big, BASIS_UNIT[fig["basis"]], theme.clean(fig["label"]), extra, CB - CT)
            if panel.height > CB - CT and extra:    # too tall: drop the optional occupancy line first
                panel = comp.figure_panel(pal, BW, big, BASIS_UNIT[fig["basis"]], theme.clean(fig["label"]), None, CB - CT)
            ys, _ = centred([panel], 0)
            sc.add(panel, PAD_X, ys[0], 0.05)
        elif sid == "L3":
            bar = comp.accent_bar(tc)
            head = comp.fitted_text("Find out what yours could take home.", "head", tc, BW, 3, 140, 80, 1.08, True, max_h=330)
            sub = comp.fitted_text("It only takes a minute.", "semi", tc, BW, 2, 56, 44, 1.15)
            sprites = [bar, head, sub]
            ys, _ = centred(sprites, 28)
            for s, y, d in zip(sprites, ys, (0.0, 0.05, 0.4)):
                sc.add(s, PAD_X, y, d)
        elif sid == "L4":
            head = comp.fitted_text("No tenancy to get stuck in.", "head", tc, BW, 3, 130, 80, 1.08, True, max_h=330)
            owner = comp.bar_text("You stay the owner.", "head", 100, inv, tc, BW, upper=True)
            sprites = [head, owner]
            if brief["fee"]:
                sprites.append(comp.fitted_text(brief["fee"], "semi", tc, BW, 2, 52, 42, 1.15))
            ys, _ = centred(sprites, 30)
            for s, y, d in zip(sprites, ys, (0.0, 0.35, 0.7)):
                sc.add(s, PAD_X, y, d)
        else:  # L5
            bar = comp.accent_bar(tc)
            head = comp.fitted_text("Have a look at our website.", "head", tc, BW, 3, 130, 80, 1.08, True, max_h=330)
            sub = comp.fitted_text("It takes about a minute, and there's no commitment.", "semi", tc, BW, 2, 54, 44, 1.15)
            btn = comp.pill("Visit our website", "semi", 48, inv, tc)
            sprites = [bar, head, sub, btn]
            ys, _ = centred(sprites, 30)
            for s, y, d in zip(sprites, ys, (0.0, 0.05, 0.4, 0.8)):
                sc.add(s, PAD_X, y, d)
        scenes.append(sc)

    pages = build_pages(brief["words"], pal)
    wins = page_windows(pages, audio_dur)
    return scenes, pages, wins


def make_drawers(scenes, pages, wins):
    starts = [s.t0 for s in scenes]

    def draw_into(cv, t):
        sc = scenes[max(0, bisect.bisect_right(starts, t) - 1)]
        sc.draw(cv, t)
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

    def frame(t):
        cv = Canvas(Image.new("RGB", (W, H)))
        draw_into(cv, t)
        return cv.im

    def extent(t):
        cv = Canvas(None)
        draw_into(cv, t)
        return cv.box

    return frame, extent


# ------------------------------------------------------------------ main
def render(brief_path):
    brief = load_brief(brief_path)
    resolve = resolver(brief_path)
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
    dur = probe_duration(audio)
    dur = min(dur, 180.0)
    try:
        os.makedirs(out_dir, exist_ok=True)
    except OSError:
        raise RenderError("render_failed")

    scenes, pages, wins = build(brief, resolve, dur)
    frame, extent = make_drawers(scenes, pages, wins)

    y0, y1 = measure_extent(extent, dur)
    if y0 < SAFE_TOP or y1 > SAFE_BOTTOM or y1 - y0 > 1080 - 80:
        raise RenderError("render_failed")
    crops = pick_crops((y0, y1))

    outs = {k: os.path.join(out_dir, v) for k, v in OUT_NAMES.items()}
    n = int(round(dur * 30))
    try:
        render_all(frame, n, audio, outs, n / 30.0, crops)
        poster_t = min(scenes[0].t0 + 1.6, dur / 2)
        frame(poster_t).save(os.path.join(out_dir, "poster.png"))
    except RenderError:
        for p in outs.values():
            try:
                os.remove(p)
            except OSError:
                pass
        raise
    return crops, (y0, y1)


class _QuietParser(argparse.ArgumentParser):
    def error(self, message):      # no usage text: the only output on failure is `ERR <code>`
        raise SystemExit(2)


def main(argv=None):
    ap = _QuietParser()
    ap.add_argument("--brief", required=True)
    try:
        args = ap.parse_args(argv)
    except SystemExit:
        sys.stderr.write("ERR bad_brief\n")
        return 2
    try:
        render(args.brief)
    except RenderError as e:
        sys.stderr.write("ERR %s\n" % e.code)
        return 1
    except Exception as e:  # never a stack trace with brief text
        if os.environ.get("AD_RENDER_DEBUG"):
            tb = e.__traceback__
            while tb.tb_next:
                tb = tb.tb_next
            sys.stderr.write("DEBUG %s line %d\n" % (type(e).__name__, tb.tb_lineno))
        sys.stderr.write("ERR render_failed\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
