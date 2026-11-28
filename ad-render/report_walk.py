"""Phone recording (55c, ad 5b on the lead database route): the customer's calculator on a phone, then the example report.

    python3 report_walk.py --brief <path to brief.json>      (brief version 2, format "phone_recording")

Scenes follow the five screen lines (timed on the voiceover, ld_common.scene_times):
  L1 the offer over the phone showing the calculator (phone_frames[0])
  L2 the form filled with the example (phone_frames[1])
  L3 the report summary scrolling inside the phone (report_pages[0]), stamped "Example report"
  L4 short let vs long let (report_pages[1]) whole in its card, with the labelled figure under it, stamped
  L5 "Get your free income report", the company and the logo
Output in brief.out_dir: phone_9x16.mp4, phone_4x5.mp4, phone_1x1.mp4, poster.png, first-frame.png, render-info.json.
On failure: one line `ERR <code>` on stderr and a non-zero exit; nothing from the brief is ever printed.
"""
import argparse
import bisect
import os
import sys

from PIL import Image

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


def build(brief, resolve, dur, pal):
    frames = brief.get("phone_frames") or []
    if not frames:
        raise RenderError("bad_brief")
    phone_imgs = [_open(resolve, f) for f in frames[:2]]
    if len(phone_imgs) == 1:
        phone_imgs.append(phone_imgs[0])
    pages = [_open(resolve, p) for p in brief["report_pages"][:2]]
    if len(pages) == 1:
        pages.append(pages[0])
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
    phones = [L.phone_shell(img, ph) for img in phone_imgs]
    # L3: the summary page at the phone's screen width, scrolled from the top.
    screen_w = phones[0].width - 28
    summary = pages[0].resize((screen_w, max(1, int(pages[0].height * screen_w / pages[0].width))), Image.LANCZOS)
    compare = L.page_card(pages[1], L.CARD_MAX_W, ph - 150)
    figure = None
    if brief.get("figure_label"):
        figure = comp.fitted_text(brief["figure_label"], "med", pal["ink"], W - 2 * L.PAD_X, 3, 34, 28, 1.2)
    cta_logo = None
    if brief["brand"].get("logo"):
        try:
            cta_logo = comp.load_logo(resolve(brief["brand"]["logo"]), height=110, max_w=360)
        except Exception:
            cta_logo = None
    cta = L.cta_block(pal, company, cta_logo, lines[4])
    times = L.scene_times(brief["script"]["lines"], dur)

    def phone_at(cv, idx, t0, t):
        spr = phones[idx]
        e = L.ease_in_scene(t, t0)
        cv.put(spr, (W - spr.width) // 2, L.CONTENT_TOP + int(30 * (1 - e)), e)

    def draw(cv, t):
        k = max(0, bisect.bisect_right(times, t) - 1)
        t0 = times[k]
        if k < 4:
            cv.put(strip, L.PAD_X, L.STRIP_Y)
            cv.put(bars[k], L.PAD_X, L.BAR_Y, L.ease_in_scene(t, t0, 0.3))
        if k == 0:
            phone_at(cv, 0, t0, t)
        elif k == 1:
            phone_at(cv, 1, t0, t)
        elif k == 2:
            body = phones[0]
            x = (W - body.width) // 2
            y = L.CONTENT_TOP
            cv.put(body, x, y)
            # scroll the summary inside the screen: from the top to at most 40% down
            span = max(0, summary.height - (body.height - 28))
            off = int(min(span, summary.height * 0.4) * ease_io(prog(t, t0 + 0.3, times[3] if len(times) > 3 else t0 + 4)))
            view = summary.crop((0, off, summary.width, off + body.height - 28))
            cv.put(L.rounded_card(view, view.width, view.height, radius=44, border=(0, 0, 0, 0)), x + 14, y + 14)
            cv.put(stamp, x + body.width - stamp.width - 24, y + 30)
        elif k == 3:
            x = (W - compare.width) // 2
            e = L.ease_in_scene(t, t0)
            cv.put(compare, x, L.CONTENT_TOP, e)
            cv.put(stamp, x + compare.width - stamp.width - 18, L.CONTENT_TOP + 18, e)
            if figure is not None:
                cv.put(figure, L.PAD_X, L.CONTENT_TOP + compare.height + 24, L.ease_in_scene(t, t0 + 0.4))
        else:
            cv.put(cta, L.PAD_X, L.CONTENT_TOP - 200 + int(30 * (1 - L.ease_in_scene(t, t0))), L.ease_in_scene(t, t0))

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
        brief = L.load_brief_v2(args.brief, "phone_recording")
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
