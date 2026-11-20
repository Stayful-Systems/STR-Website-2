"""Reusable sprite builders. Every one returns a Pillow RGBA image (a "sprite") that the
frame code places with Canvas.put, so text is laid out once, not on every frame."""
from PIL import Image, ImageDraw, ImageOps

import theme
from theme import font


def _rgba(rgb, a=255):
    return tuple(int(v) for v in rgb[:3]) + (a,)


# ------------------------------------------------------------------ text
def text_block(lines, style, size, colour, lh, align="left", width=None, pad=6, tight=False):
    """Several lines of one font as one sprite. width fixes the sprite width (for alignment)."""
    f = font(style, size)
    w = int(max(f.getlength(l) for l in lines)) + pad * 2
    if width:
        w = max(w, width)
    asc, dsc = f.getmetrics()
    h = lh * (len(lines) - 1) + asc + dsc + pad * 2
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    for i, line in enumerate(lines):
        base = pad + asc + i * lh
        if align == "center":
            d.text((w / 2, base), line, font=f, fill=_rgba(colour), anchor="ms")
        else:
            d.text((pad, base), line, font=f, fill=_rgba(colour), anchor="ls")
    if tight:   # trim the empty space above and below the glyphs (big numbers)
        bb = im.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
        if bb:
            im = im.crop((0, max(0, bb[1] - 4), im.width, min(im.height, bb[3] + 4)))
    return im


def fitted_text(text, style, colour, max_w, max_lines, size_max, size_min, lh=1.1,
                upper=False, align="left", max_h=None):
    """Text fitted to a box: the largest size that wraps inside it. Returns the sprite."""
    text = theme.clean(text)
    while True:
        lines, size, lhp, ok = theme.fit(text, style, max_w, max_lines, size_max, size_min, lh, upper)
        f = font(style, size)
        asc, dsc = f.getmetrics()
        total = lhp * (len(lines) - 1) + asc + dsc + 12
        if max_h is None or total <= max_h or size <= size_min:
            return text_block(lines, style, size, colour, lhp, align, width=int(max_w) if align == "center" else None,
                              tight=(style == "head"))
        size_max = size - 2


def accent_bar(colour, w=120, h=12):
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(im).rounded_rectangle((0, 0, w - 1, h - 1), radius=h // 2, fill=_rgba(colour, 230))
    return im


def bar_text(text, style, size, fg, bg, max_w, padx=26, pady=10, upper=False):
    """Text on a solid highlighter bar (inverse of the surrounding type). Wraps to max_w."""
    text = theme.clean(text)
    lines, size, lhp, _ = theme.fit(text, style, max_w - padx * 2, 2, size, max(36, size // 2), 1.08, upper)
    f = font(style, size)
    asc, dsc = f.getmetrics()
    tw = int(max(f.getlength(l) for l in lines))
    w = tw + padx * 2
    h = lhp * (len(lines) - 1) + asc + dsc + pady * 2
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, w - 1, h - 1), radius=14, fill=_rgba(bg))
    for i, line in enumerate(lines):
        d.text((padx, pady + asc + i * lhp), line, font=f, fill=_rgba(fg), anchor="ls")
    return im


def pill(text, style, size, fg, bg, padx=44, pady=16, outline=None):
    text = theme.clean(text)
    f = font(style, size)
    asc, dsc = f.getmetrics()
    w = int(f.getlength(text)) + padx * 2
    h = asc + dsc + pady * 2
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, w - 1, h - 1), radius=h // 2, fill=_rgba(bg) if bg else None,
                        outline=_rgba(outline) if outline else None, width=4 if outline else 0)
    d.text((w / 2, pady + asc), text, font=f, fill=_rgba(fg), anchor="ms")
    return im


def vstack(sprites, gap=24, align="left", width=None):
    """Stack sprites top to bottom. Returns (sprite, [y offsets])."""
    sprites = [s for s in sprites if s is not None]
    w = width or max(s.width for s in sprites)
    h = sum(s.height for s in sprites) + gap * (len(sprites) - 1)
    im = Image.new("RGBA", (w, max(1, h)), (0, 0, 0, 0))
    y = 0
    for s in sprites:
        x = 0 if align == "left" else (w - s.width) // 2
        im.alpha_composite(s, (x, y))
        y += s.height + gap
    return im


# ------------------------------------------------------------------ logo
def load_logo(path, height=64, max_w=220):
    """The operator's PNG, trimmed, on a white rounded chip so any logo reads on any background."""
    src = ImageOps.exif_transpose(Image.open(path)).convert("RGBA")
    bb = src.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    if bb:
        src = src.crop(bb)
    k = min(height / src.height, max_w / src.width)
    src = src.resize((max(1, int(src.width * k)), max(1, int(src.height * k))), Image.LANCZOS)
    pad = 10
    chip = Image.new("RGBA", (src.width + pad * 2, src.height + pad * 2), (0, 0, 0, 0))
    ImageDraw.Draw(chip).rounded_rectangle((0, 0, chip.width - 1, chip.height - 1), radius=14,
                                           fill=(255, 255, 255, 255))
    chip.alpha_composite(src, (pad, pad))
    return chip


def brand_strip(strip, width, logo=None, company=None, text_colour=None, height=104):
    """Strip carrying the logo chip on the left and the company name in type beside it.
    strip is its RGBA fill (translucent, so it sits on a photo or a solid colour alike)."""
    im = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    ImageDraw.Draw(im).rounded_rectangle((0, 0, width - 1, height - 1), radius=26, fill=tuple(strip))
    x = 20
    if logo is not None:
        im.alpha_composite(logo, (x, (height - logo.height) // 2))
        x += logo.width + 22
    if company:
        room = width - x - 24
        words = theme.clean(company).split()
        while True:     # shorten (with an ellipsis) until it fits on at most 2 lines at 32 px or more
            txt = " ".join(words) + ("\u2026" if len(words) < len(theme.clean(company).split()) else "")
            lines, size, lhp, ok = theme.fit(txt, "semi", room, 2, 44, 32, 1.1)
            if ok or len(words) <= 1:
                break
            words = words[:-1]
        spr = text_block(lines, "semi", size, text_colour, lhp)
        im.alpha_composite(spr, (x - 6, (height - spr.height) // 2))
    return im


# ------------------------------------------------------------------ figure panel
def money(v):
    return "£{:,}".format(int(round(v)))


def figure_panel(palette, width, big, unit, label, extra, max_h):
    """The labelled example: big number, its unit, optional extra line, and the WHOLE label
    sentence. The label is never cropped: type shrinks (not below 34 px), then the panel grows
    to fit; the caller checks the height against its band."""
    pad = 40
    inner = width - pad * 2
    parts = []
    if big:
        for size in range(180, 99, -8):
            f = font("head", size)
            if f.getlength(big) <= inner:
                break
        parts.append(text_block([big], "head", size, palette["panel_number"], int(size * 1.1), tight=True))
        parts.append(fitted_text(unit, "semi", palette["panel_text"], inner, 2, 52, 38, 1.15))
        if extra:
            parts.append(fitted_text(extra, "med", palette["panel_text"], inner, 1, 40, 34, 1.15))
    for label_size in (44, 42, 40, 38, 36, 34):
        lab = fitted_text(label, "med", palette["panel_text"], inner, 6, label_size, label_size, 1.25)
        stack = vstack(parts + [lab], gap=18)
        if stack.height + pad * 2 + 26 <= max_h:
            break
    rule = 4
    h = stack.height + pad * 2 + (rule + 22 if big else 0)
    im = Image.new("RGBA", (width, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, width - 1, h - 1), radius=36, fill=_rgba(palette["panel"]))
    # the label sits under a thin rule, apart from the number
    y = pad
    for s in parts:
        im.alpha_composite(s, (pad - 6, y))
        y += s.height + 18
    if big:
        d.line([(pad, y + 2), (width - pad, y + 2)], fill=_rgba(palette["tints"]["mid"]), width=rule)
        y += rule + 22
    im.alpha_composite(lab, (pad - 6, y))
    return im
