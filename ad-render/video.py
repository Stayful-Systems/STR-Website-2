"""Frame drawing, easing and ffmpeg encoding for the notice video.

Frames are drawn with Pillow at 1080x1920, 30 fps, in worker processes, and streamed as raw RGB
into ONE ffmpeg process that writes all three sizes (9:16, plus 4:5 and 1:1 crops of it) and the
audio in a single pass. All ffmpeg and ffprobe calls pass their arguments as lists.

Safe areas on the 9:16 (Meta's interface covers them): nothing is drawn in the top 14%
(y < 270) or the bottom 20% (y > 1536). The notice code keeps its content in a tighter band so
the square and portrait crops hold every element too.
"""
import multiprocessing
import os
import subprocess

from PIL import Image

W, H, FPS = 1080, 1920, 30
SAFE_TOP, SAFE_BOTTOM = 270, 1536          # 14% and 80% of 1920
CROPS = (("4x5", 1350, 135), ("1x1", 1080, 40))   # (name, height, minimum margin below content)


class RenderError(Exception):
    """code is one of bad_brief, missing_asset, render_failed, ffmpeg_failed."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


# ------------------------------------------------------------------ easing
def clamp(x, a=0.0, b=1.0):
    return max(a, min(b, x))


def prog(t, a, b):
    return clamp((t - a) / (b - a)) if b > a else (1.0 if t >= b else 0.0)


def ease_out(x):
    return 1 - (1 - x) ** 3


def ease_back(x, k=1.7):
    x -= 1
    return 1 + (k + 1) * x ** 3 + k * x ** 2


def ease_io(x):
    return 4 * x ** 3 if x < 0.5 else 1 - (-2 * x + 2) ** 3 / 2


# ------------------------------------------------------------------ canvas
_BBOX = {}


def _sprite_info(spr):
    """(alpha channel, visible bbox) of a sprite, computed once."""
    key = id(spr)
    hit = _BBOX.get(key)
    if hit is None or hit[0] is not spr:
        alpha = spr.getchannel("A")
        bb = alpha.point(lambda v: 255 if v > 40 else 0).getbbox() or (0, 0, 0, 0)
        hit = (spr, alpha, bb)
        _BBOX[key] = hit
    return hit[1], hit[2]


class Canvas:
    """Where one frame is drawn. With im=None it only records the extent of everything placed
    (the measuring pass), so the crop offsets come from the real content."""

    def __init__(self, im=None):
        self.im = im
        self.box = None

    def mark(self, x0, y0, x1, y1):
        if x1 <= x0 or y1 <= y0:
            return
        b = self.box
        self.box = (x0, y0, x1, y1) if b is None else (min(b[0], x0), min(b[1], y0), max(b[2], x1), max(b[3], y1))

    def put(self, spr, x, y, a=1.0):
        """Place a sprite with its top-left at (x, y), at opacity a."""
        if spr is None or a <= 0.02:
            return
        alpha, bb = _sprite_info(spr)
        x, y = int(x), int(y)
        self.mark(x + bb[0], y + bb[1], x + bb[2], y + bb[3])
        if self.im is None:
            return
        if a < 0.995:
            alpha = alpha.point(lambda v, a=a: int(v * a))
        self.im.paste(spr, (x, y), alpha)

    def put_centre(self, spr, cx, y, a=1.0):
        self.put(spr, cx - spr.width / 2, y, a)


# ------------------------------------------------------------------ ffmpeg
def run(cmd, timeout=600):
    """Run a command (argument list, never a shell string); output is captured, never shown."""
    try:
        r = subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        raise RenderError("ffmpeg_failed")
    return r


def probe_duration(path):
    r = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], 60)
    try:
        d = float(r.stdout.decode().strip())
    except ValueError:
        raise RenderError("ffmpeg_failed")
    if r.returncode != 0 or not (0.5 < d < 300):
        raise RenderError("ffmpeg_failed")
    return d


def has_audio(path):
    r = run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type",
             "-of", "csv=p=0", path], 60)
    return r.returncode == 0 and b"audio" in r.stdout


def pick_crops(extent):
    """Crop offsets for the 4:5 and 1:1 windows from the measured content extent (y0, y1) of the
    9:16: centred on the content, moved only as far as needed to keep a margin above and below
    (below the 4:5 content is also kept clear of the bottom 10%). Offsets are even."""
    y0, y1 = extent
    out = {}
    for name, ch, below in CROPS:
        lo = y1 + below - ch          # smallest offset that keeps the bottom margin
        hi = y0 - 40                  # largest offset that keeps 40 px above
        if lo > hi:
            raise RenderError("render_failed")
        want = (y0 + y1) / 2 - ch / 2
        off = int(max(lo, min(hi, want)))
        off -= off % 2
        if off < lo:
            off += 2
        off = max(0, min(H - ch, off))
        if not (y0 - off >= 0 and y1 - off <= ch):
            raise RenderError("render_failed")
        out[name] = off
    return out


def encode_cmd(audio, outs, dur, crops):
    """One ffmpeg process: raw frames in, three MP4s out."""
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
           "-r", str(FPS), "-i", "-", "-i", audio]
    graph = (f"[0:v]format=yuv420p,split=3[a][b][c];"
             f"[b]crop={W}:1350:0:{crops['4x5']}[b2];[c]crop={W}:1080:0:{crops['1x1']}[c2]")
    cmd += ["-filter_complex", graph]
    enc = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-r", str(FPS),
           "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-af", "apad", "-movflags", "+faststart", "-t", f"{dur:.3f}"]
    for label, path in (("[a]", outs["9x16"]), ("[b2]", outs["4x5"]), ("[c2]", outs["1x1"])):
        cmd += ["-map", label, "-map", "1:a"] + enc + [path]
    return cmd


# ------------------------------------------------------------------ rendering
_DRAW = None


def _frame_bytes(i):
    im = _DRAW(i / FPS)
    return im.tobytes()


def render_all(draw, n, audio, outs, dur, crops, jobs=None):
    """draw(t) -> RGB image. Frames are made in `jobs` worker processes, in small batches so memory
    stays bounded, and written in order to ffmpeg."""
    global _DRAW
    _DRAW = draw
    jobs = jobs or int(os.environ.get("AD_RENDER_JOBS", "0") or 0) or min(4, os.cpu_count() or 2)
    proc = subprocess.Popen(encode_cmd(audio, outs, dur, crops), stdin=subprocess.PIPE,
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    batch = 12
    ctx = multiprocessing.get_context("fork")
    try:
        with ctx.Pool(jobs) as pool:
            ranges = [range(s, min(n, s + batch)) for s in range(0, n, batch)]
            pending = pool.map_async(_frame_bytes, ranges[0]) if ranges else None
            for k in range(len(ranges)):
                got = pending.get()
                if k + 1 < len(ranges):
                    pending = pool.map_async(_frame_bytes, ranges[k + 1])
                for raw in got:
                    proc.stdin.write(raw)
        proc.stdin.close()
        proc.wait(timeout=600)
    except BrokenPipeError:
        proc.kill()
        raise RenderError("ffmpeg_failed")
    except RenderError:
        proc.kill()
        raise
    except Exception:
        proc.kill()
        raise RenderError("render_failed")
    if proc.returncode != 0:
        raise RenderError("ffmpeg_failed")


def measure_extent(extent_at, dur, step=0.1):
    """Union of the content boxes over the whole timeline (no photo or encoding work)."""
    y0, y1 = H, 0
    n = int(dur / step) + 1
    for i in range(n):
        box = extent_at(min(dur, i * step))
        if box is not None:
            y0, y1 = min(y0, box[1]), max(y1, box[3])
    if y1 <= y0:
        raise RenderError("render_failed")
    return y0, y1
