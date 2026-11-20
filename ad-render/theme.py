"""Brand theme for the notice video: every colour comes from ONE brand colour.

The maths mirrors the image ads in src/lib/ad-packs (images.tsx deriveTints and
paletteFor, checks.ts contrastRatio and pickTextColour), so the video and the
image cards of one pack read as one family:

    base   the operator's colour (the background)
    dark   30% towards black       deep   60% towards black
    mid    25% towards white       light  90% towards white
    text   white or near-black, whichever has the higher WCAG contrast on base

Colours are RGB tuples here; hex strings only at the edges.
"""
import functools
import os
import re

from PIL import ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONT_DIR = os.path.join(HERE, "fonts")

# Same constants as checks.ts.
TEXT_ON_DARK = (255, 255, 255)
TEXT_ON_LIGHT = (17, 17, 17)
HEX6 = re.compile(r"^#[0-9a-fA-F]{6}$")

FONT_FILES = {
    "head": "Anton-Regular.ttf",      # headlines, big numbers
    "semi": "Archivo-SemiBold.ttf",   # lines meant to be read, captions
    "med": "Archivo-Medium.ttf",      # labels
}


class FontMissing(Exception):
    pass


@functools.lru_cache(None)
def font(style, size):
    path = os.path.join(FONT_DIR, FONT_FILES[style])
    try:
        return ImageFont.truetype(path, int(size))
    except OSError as exc:
        raise FontMissing(style) from exc


# ------------------------------------------------------------------ colour
def parse_hex(value):
    """#rrggbb to an (r, g, b) tuple, or None when it is not a 6-digit hex."""
    if not isinstance(value, str) or not HEX6.match(value.strip()):
        return None
    h = value.strip()[1:]
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def to_hex(rgb):
    return "#" + "".join("%02x" % max(0, min(255, int(round(v)))) for v in rgb)


def mix(rgb, target, amount):
    return tuple(c + (target - c) * amount for c in rgb)


def _channel(v):
    s = v / 255.0
    return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4


def luminance(rgb):
    r, g, b = rgb
    return 0.2126 * _channel(r) + 0.7152 * _channel(g) + 0.0722 * _channel(b)


def contrast(a, b):
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def pick_text(rgb):
    """White or near-black, whichever has the higher contrast on rgb."""
    return TEXT_ON_LIGHT if contrast(rgb, TEXT_ON_LIGHT) > contrast(rgb, TEXT_ON_DARK) else TEXT_ON_DARK


def _round(rgb):
    return tuple(int(round(max(0, min(255, c)))) for c in rgb)


def derive_tints(rgb):
    return {
        "base": _round(rgb),
        "dark": _round(mix(rgb, 0, 0.3)),
        "deep": _round(mix(rgb, 0, 0.6)),
        "mid": _round(mix(rgb, 255, 0.25)),
        "light": _round(mix(rgb, 255, 0.9)),
    }


def palette_for(rgb):
    """The whole video palette from one colour."""
    t = derive_tints(rgb)
    text = pick_text(t["base"])
    light_text = text == TEXT_ON_DARK
    # The caption highlight is the brand colour itself unless it hardly shows on the light plate.
    mark = t["base"] if contrast(t["base"], t["light"]) >= 2.0 else t["deep"]
    return {
        "tints": t,
        "base": t["base"],
        "text": text,
        "accent": text,
        "overlay": t["dark"] if light_text else t["base"],
        "panel": t["light"],
        "panel_text": TEXT_ON_LIGHT,
        "panel_number": t["deep"] if contrast(t["deep"], t["light"]) >= 7 else TEXT_ON_LIGHT,
        "strip": (t["deep"] if light_text else TEXT_ON_LIGHT) + ((140,) if light_text else (30,)),
        "plate": t["light"],
        "mark": mark,
        "mark_text": pick_text(mark),
    }


def surface_text(rgb):
    """Type colour on a solid surface of any tint."""
    return pick_text(rgb)


def overlay_alpha(overlay_rgb, text_rgb, floor=0.55, ceil=0.92, want=4.5):
    """Lowest overlay opacity at which the type still reads (>= want : 1) over the
    worst photo, a pure white or pure black one. Lets the photo show as much as it can."""
    a = floor
    while a < ceil:
        worst = 99.0
        for photo in (255, 0):
            bg = tuple(photo * (1 - a) + c * a for c in overlay_rgb)
            worst = min(worst, contrast(bg, text_rgb))
        if worst >= want:
            return round(a, 2)
        a += 0.02
    return ceil


# ------------------------------------------------------------------ text
_OK_RANGES = ((0x20, 0x7E), (0xA0, 0x17F), (0x2010, 0x2027), (0x20AC, 0x20AC), (0x2122, 0x2122))


def clean(text, limit=None):
    """Printable text the bundled fonts can draw: control characters and glyphs outside
    Latin, common punctuation, the pound and euro signs are dropped (no empty boxes)."""
    out = []
    for ch in str(text):
        o = ord(ch)
        if ch in "\r\n\t":
            out.append(" ")
        elif any(a <= o <= b for a, b in _OK_RANGES):
            out.append(ch)
    s = re.sub(r"\s+", " ", "".join(out)).strip()
    if limit and len(s) > limit:
        s = s[: limit - 1].rstrip() + "…"
    return s


def wrap(text, fnt, max_w):
    """Greedy word wrap by real glyph widths. A word wider than the line is split by characters."""
    lines, cur = [], ""
    for word in text.split():
        trial = (cur + " " + word).strip()
        if fnt.getlength(trial) <= max_w:
            cur = trial
            continue
        if cur:
            lines.append(cur)
            cur = ""
        while fnt.getlength(word) > max_w and len(word) > 1:
            cut = len(word) - 1
            while cut > 1 and fnt.getlength(word[:cut]) > max_w:
                cut -= 1
            lines.append(word[:cut])
            word = word[cut:]
        cur = word
    if cur:
        lines.append(cur)
    return lines or [""]


def fit(text, style, max_w, max_lines, size_max, size_min, lh=1.1, upper=False, step=2):
    """Largest size in [size_min, size_max] at which text wraps in <= max_lines lines no wider
    than max_w. Returns (lines, size, line_height_px, fitted). At the minimum it returns the
    wrapped lines even if they exceed max_lines (fitted False), never cropped text."""
    if upper:
        text = text.upper()
    size = size_max
    while True:
        f = font(style, size)
        lines = wrap(text, f, max_w)
        if len(lines) <= max_lines and all(f.getlength(l) <= max_w for l in lines):
            return lines, size, int(size * lh), True
        if size - step < size_min:
            return lines, size_min, int(size_min * lh), False
        size -= step
