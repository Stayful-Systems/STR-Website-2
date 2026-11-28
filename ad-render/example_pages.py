"""Example report pages: the customer's branded example report as masked pictures (55c A2).

    python3 example_pages.py --job <path to job.json>

job.json (written by src/lib/ad-packs/example-step.ts):
    { "pdf": "example.pdf", "out_dir": "out/pages", "first": 1, "last": 4, "dpi": 144,
      "stamp": "Example report", "pound": ["£"], "percent": true,
      "targets": [ { "id": "comparables", "headings": ["Other listings", ...] }, ... ],
      "brand_colour": "#RRGGBB" }

What it does, in the sandbox, with poppler-utils:
  1. pdftoppm -r <dpi> -f <first> -l <last> -png      the pages as pictures (2x)
  2. pdftotext -bbox-layout                          the exact box of every word the PDF drew
  3. every word carrying a £ (and a bare "£" with the number after it), and with "percent" every percentage
     ("15%", and a bare "%" with the number before it), is blurred until it cannot be read
  4. "Example report" is stamped on every page
  5. the loupe's three stops are found from the section headings
Writes <out_dir>/page-N.png and <out_dir>/pages.json:
    { "pages": [ { "file", "width", "height", "masked", "stamped" } ], "targets": [ { "page", "x", "y", "w", "h" } ] }
On failure: one line `ERR <code>` on stderr and a non-zero exit; nothing from the report is ever printed.
"""
import argparse
import html
import json
import os
import re
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFilter

import theme
from theme import font

PAGE_RE = re.compile(r'<page width="([\d.]+)" height="([\d.]+)">(.*?)</page>', re.S)
LINE_RE = re.compile(r'<line [^>]*>(.*?)</line>', re.S)
WORD_RE = re.compile(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</word>', re.S)

# A loupe stop: from just above the heading, the whole width, this much of the page down.
STOP_H = 0.22
STOP_X, STOP_W = 0.04, 0.92


class JobError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


# ------------------------------------------------------------------ pure parts (tested)
def parse_bbox(xhtml):
    """pdftotext -bbox-layout output -> [{width, height, lines: [[{x0, y0, x1, y1, text}]]}] in PDF points."""
    pages = []
    for pm in PAGE_RE.finditer(xhtml or ""):
        lines = []
        for lm in LINE_RE.finditer(pm.group(3)):
            words = [
                {"x0": float(w[0]), "y0": float(w[1]), "x1": float(w[2]), "y1": float(w[3]), "text": html.unescape(w[4]).strip()}
                for w in WORD_RE.findall(lm.group(1))
            ]
            if words:
                lines.append(words)
        pages.append({"width": float(pm.group(1)), "height": float(pm.group(2)), "lines": lines})
    return pages


def pound_boxes(lines, marks=("£",)):
    """The boxes to blur on one page: every word with a £ in it, and the word after a bare "£"."""
    out = []
    for words in lines:
        for i, w in enumerate(words):
            if any(m in w["text"] for m in marks):
                box = dict(w)
                if w["text"] in marks and i + 1 < len(words):
                    nxt = words[i + 1]
                    box["x1"] = max(box["x1"], nxt["x1"])
                    box["y0"] = min(box["y0"], nxt["y0"])
                    box["y1"] = max(box["y1"], nxt["y1"])
                out.append(box)
    return out


PERCENT_RE = re.compile(r"\d[\d.,]*\s*%")


def percent_boxes(lines):
    """The percentage boxes to blur on one page (Zac, 28 Nov: fee and occupancy percentages are figures too):
    every word with a number then "%" in it, and a bare "%" together with the number word before it."""
    out = []
    for words in lines:
        for i, w in enumerate(words):
            if PERCENT_RE.search(w["text"]):
                out.append(dict(w))
            elif w["text"].strip() == "%" and i > 0 and re.search(r"\d", words[i - 1]["text"]):
                prev = words[i - 1]
                box = dict(w)
                box["x0"] = min(box["x0"], prev["x0"])
                box["y0"] = min(box["y0"], prev["y0"])
                box["y1"] = max(box["y1"], prev["y1"])
                out.append(box)
    return out


def find_targets(pages, specs):
    """The loupe's stops: for each spec, the first page and line that starts with one of its headings (case kept)."""
    out = []
    for spec in specs:
        hit = None
        for heading in spec.get("headings", []):
            want = heading.split()
            for pi, page in enumerate(pages):
                for words in page["lines"]:
                    texts = [w["text"] for w in words]
                    for s in range(0, len(texts) - len(want) + 1):
                        if texts[s:s + len(want)] == want:
                            hit = (pi, words[s], page)
                            break
                    if hit:
                        break
                if hit:
                    break
            if hit:
                break
        if not hit:
            raise JobError("no_target")
        pi, w, page = hit
        y = max(0.0, min(1.0 - STOP_H, w["y0"] / page["height"] - 0.01))
        out.append({"page": pi, "x": STOP_X, "y": round(y, 4), "w": STOP_W, "h": STOP_H})
    return out


def scale_box(box, page_w, page_h, img_w, img_h, pad=3):
    sx, sy = img_w / page_w, img_h / page_h
    return (
        max(0, int(box["x0"] * sx) - pad),
        max(0, int(box["y0"] * sy) - pad),
        min(img_w, int(box["x1"] * sx + 0.999) + pad),
        min(img_h, int(box["y1"] * sy + 0.999) + pad),
    )


def blur_region(img, rect):
    """Make a region unreadable: pixelate it to a few blocks, then blur. Outside it nothing changes."""
    x0, y0, x1, y1 = rect
    if x1 - x0 < 2 or y1 - y0 < 2:
        return
    region = img.crop(rect)
    w, h = region.size
    small = region.resize((max(1, w // 12), max(1, h // 12)), Image.BILINEAR)
    region = small.resize((w, h), Image.BILINEAR).filter(ImageFilter.GaussianBlur(radius=max(4, h // 3)))
    img.paste(region, rect)


def stamp(img, text, colour_hex):
    """'Example report' in a solid label at the top right of the page."""
    rgb = theme.parse_hex(colour_hex) or (31, 58, 95)
    fg = theme.pick_text(rgb)
    d = ImageDraw.Draw(img)
    size = max(18, img.width // 34)
    f = font("semi", size)
    tw = int(d.textlength(text, font=f))
    padx, pady = size // 2, size // 3
    x1 = img.width - size
    x0 = x1 - tw - padx * 2
    y0 = size
    y1 = y0 + size + pady * 2
    d.rounded_rectangle((x0, y0, x1, y1), radius=size // 2, fill=rgb)
    d.text((x0 + padx, y0 + pady - size // 8), text, font=f, fill=fg)
    return (x0, y0, x1, y1)


# ------------------------------------------------------------------ the job
def _run(cmd, timeout=120):
    try:
        res = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except Exception:
        raise JobError("pages_failed")
    if res.returncode != 0:
        raise JobError("pages_failed")
    return res.stdout


def run_job(job_path):
    base = os.path.dirname(os.path.abspath(job_path))
    with open(job_path, "r", encoding="utf-8") as fh:
        job = json.load(fh)
    pdf = os.path.join(base, job["pdf"])
    out_dir = os.path.join(base, job["out_dir"])
    os.makedirs(out_dir, exist_ok=True)
    first, last, dpi = int(job["first"]), int(job["last"]), int(job["dpi"])
    prefix = os.path.join(out_dir, "raw")
    _run(["pdftoppm", "-r", str(dpi), "-f", str(first), "-l", str(last), "-png", pdf, prefix])
    xhtml = _run(["pdftotext", "-bbox-layout", "-f", str(first), "-l", str(last), pdf, "-"]).decode("utf-8", "replace")
    pages = parse_bbox(xhtml)
    raws = sorted(f for f in os.listdir(out_dir) if f.startswith("raw") and f.endswith(".png"))
    if not raws or len(raws) != len(pages):
        raise JobError("pages_failed")
    targets = find_targets(pages, job.get("targets", []))
    info = []
    for i, (raw, page) in enumerate(zip(raws, pages), start=1):
        img = Image.open(os.path.join(out_dir, raw)).convert("RGB")
        boxes = pound_boxes(page["lines"], tuple(job.get("pound", ["£"])))
        if job.get("percent", True):
            boxes += percent_boxes(page["lines"])
        for b in boxes:
            blur_region(img, scale_box(b, page["width"], page["height"], img.width, img.height))
        stamp(img, job.get("stamp", "Example report"), job.get("brand_colour", "#1F3A5F"))
        name = "page-%d.png" % i
        img.save(os.path.join(out_dir, name), "PNG", optimize=True)
        os.remove(os.path.join(out_dir, raw))
        info.append({"file": name, "width": img.width, "height": img.height, "masked": len(boxes), "stamped": True})
    with open(os.path.join(out_dir, "pages.json"), "w", encoding="utf-8") as fh:
        json.dump({"pages": info, "targets": targets}, fh)


class _QuietParser(argparse.ArgumentParser):
    def error(self, message):
        raise JobError("bad_job")


def main(argv=None):
    parser = _QuietParser(add_help=False)
    parser.add_argument("--job", required=True)
    try:
        args = parser.parse_args(argv)
        run_job(args.job)
    except JobError as e:
        print("ERR %s" % e.code, file=sys.stderr)
        return 2
    except Exception:
        print("ERR pages_failed", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
