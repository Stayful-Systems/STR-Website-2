"""Loupe (55c, ad 17 on the lead database route): a page of the example report under a moving magnifier.

    python3 loupe.py --brief <path to brief.json>      (brief version 2, format "loupe")

Scenes follow the five screen lines (timed on the voiceover, ld_common.scene_times):
  L1 the offer over the full page (the page of the first stop), stamped "Example report"
  L2 to L4 the magnifier moves to the comparables, the occupancy and the local demand (brief.targets, found from the
     section headings when the pages were made), each enlarged in a lens over the page
  L5 "Get your free income report", the company and the logo
Output in brief.out_dir: loupe_9x16.mp4, loupe_4x5.mp4, loupe_1x1.mp4, poster.png, first-frame.png, render-info.json.
On failure: one line `ERR <code>` on stderr and a non-zero exit; nothing from the brief is ever printed.
"""
import argparse
import bisect
import os
import sys

from PIL import Image, ImageDraw

import components as comp
import ld_common as L
from video import RenderError, W, ease_io, prog


def _open(resolve, rel):
    p = resolve(rel)
    if not os.path.isfile(p):
        raise RenderError("missing_asset")
    try:
        return Image.open(p).convert("RGB")
    except Exception:
        raise RenderError("missing_asset")


def lens_sprite(region, pal):
    w, h = region.size
    ring = 8
    spr = Image.new("RGBA", (w + ring * 2, h + ring * 2), (0, 0, 0, 0))
    ImageDraw.Draw(spr).rounded_rectangle((0, 0, spr.width - 1, spr.height - 1), radius=40, fill=pal["brand"] + (255,))
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), radius=32, fill=255)
    spr.paste(region, (ring, ring), mask)
    return spr


def build(brief, resolve, dur, pal):
    targets = brief.get("targets") or []
    if len(targets) != 3:
        raise RenderError("bad_brief")
    pages = [_open(resolve, p) for p in brief["report_pages"]]
    for t in targets:
        if not isinstance(t.get("page"), int) or not (0 <= t["page"] < len(pages)):
            raise RenderError("bad_brief")
    logo = None
    if brief["brand"].get("logo"):
        try:
            logo = comp.load_logo(resolve(brief["brand"]["logo"]), height=60)
        except Exception:
            logo = None
    company = brief["brand"]["company"].strip()
    lines = brief["screen_lines"]
    strip = L.logo_strip(pal, logo, company)
    bars = [L.headline_bar(t, pal) for t in lines[:4]]
    stamp = L.stamp_sprite(brief["stamp"], pal)
    ph = L.CONTENT_BOTTOM - L.CONTENT_TOP
    cards = {}
    for t in targets:
        if t["page"] not in cards:
            cards[t["page"]] = L.page_card(pages[t["page"]], L.CARD_MAX_W, ph)
    lenses = [lens_sprite(L.lens(pages[t["page"]], t, out_w=W - 2 * L.PAD_X - 16, out_h=260), pal) for t in targets]
    cta_logo = None
    if brief["brand"].get("logo"):
        try:
            cta_logo = comp.load_logo(resolve(brief["brand"]["logo"]), height=110, max_w=360)
        except Exception:
            cta_logo = None
    cta = L.cta_block(pal, company, cta_logo, lines[4])
    times = L.scene_times(brief["script"]["lines"], dur)

    def card_pos(card):
        return (W - card.width) // 2, L.CONTENT_TOP

    def draw(cv, t):
        k = max(0, bisect.bisect_right(times, t) - 1)
        t0 = times[k]
        if k == 4:
            e = L.ease_in_scene(t, t0)
            cv.put(cta, L.PAD_X, L.CONTENT_TOP - 200 + int(30 * (1 - e)), e)
            return
        cv.put(strip, L.PAD_X, L.STRIP_Y)
        cv.put(bars[k], L.PAD_X, L.BAR_Y, L.ease_in_scene(t, t0, 0.3))
        stop = targets[0 if k == 0 else k - 1]
        card = cards[stop["page"]]
        x, y = card_pos(card)
        cv.put(card, x, y)
        cv.put(stamp, x + card.width - stamp.width - 18, y + 18)
        if k == 0:
            return
        # the lens glides from the previous stop's height to this one's, then holds
        prev = targets[k - 2] if k >= 2 else stop
        e = ease_io(prog(t, t0, t0 + 0.6))
        fy = prev["y"] + (stop["y"] - prev["y"]) * e if prev["page"] == stop["page"] else stop["y"]
        ly = y + int(fy * card.height) - 20
        spr = lenses[k - 1]
        ly = max(L.CONTENT_TOP, min(L.CONTENT_BOTTOM - spr.height, ly))
        cv.put(spr, (W - spr.width) // 2, ly, L.ease_in_scene(t, t0, 0.3))

    return draw, ["L1", "L2", "L3", "L4", "L5"]


class _QuietParser(argparse.ArgumentParser):
    def error(self, message):
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
        brief = L.load_brief_v2(args.brief, "loupe")
        L.encode(brief, L.resolver(args.brief), build)
    except RenderError as e:
        sys.stderr.write("ERR %s\n" % e.code)
        return 1
    except Exception:
        sys.stderr.write("ERR render_failed\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
