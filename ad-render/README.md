# ad-render: the tenant-notice video (Batch 38b)

Renders the 5b ad (a tenant has handed in their notice) as a real video in the operator's own brand:
`notice_9x16.mp4`, plus `notice_4x5.mp4` and `notice_1x1.mp4` (crops of the 9:16) and `poster.png`.
Python 3.11+, Pillow, ffmpeg. No network is used at render time. Brand-neutral: every colour comes
from the one brand colour in the brief, every word from the brief or the fixed on-screen lines in
`notice.py`.

## Run

    pip install -r ad-render/requirements.txt
    python3 ad-render/notice.py --brief <path to brief.json>

Paths inside the brief are relative to the folder the brief sits in, and may not leave it. The
folder is the working directory's business only for the command line itself; nothing else depends
on the current directory (fonts load from `ad-render/fonts/` next to the script).

System needs: `ffmpeg` and `ffprobe` on PATH (libx264 and aac; tested with 6.1). The fonts are bundled
(`fonts/`: Anton, Archivo Medium and SemiBold, SIL OFL, see `fonts/OFL.txt`). Frames are drawn in
worker processes (one per CPU, at most 4; set `AD_RENDER_JOBS` to override) and streamed into a single
ffmpeg process that writes all three sizes and the audio in one pass (`-preset veryfast -crf 22`,
h264 yuv420p, aac, faststart).

Timing (38 s ad, 5 scenes, 2 photos, logo): about 28 s on 4 CPUs, about 44 s limited to 2 CPUs.

Local try-out with generated assets (no real photos or logos):

    python3 ad-render/sample/make_sample.py            # --variant full | bare | longname
    python3 ad-render/notice.py --brief ad-render/sample/brief.json   # writes ad-render/sample/out/

## Look

Background = the brand colour; tints are derived from it with the same maths as the image ads
(`src/lib/ad-packs/images.tsx` deriveTints/paletteFor, `checks.ts` contrastRatio/pickTextColour):
dark = 30% to black, deep = 60% to black, mid = 25% to white, light = 90% to white; type is white or
near-black (#111111), whichever has the higher WCAG contrast. Headlines are Anton, uppercase; other
type Archivo. Operator photos (0 to 4) are Ken-Burns backgrounds under a brand-coloured overlay whose
opacity is the lowest that keeps the type at 4.5:1 or better over even a pure white or black photo.
With no photos the look is type only: solid brand tints. The logo sits on a white chip in a strip at
the top of the content band, with the company name in type beside it (the hook scene shows the name
big instead). Burned-in captions (at most 2 lines of about 28 characters, a highlighted current word)
are built from `script.words`. Smallest type anywhere: 34 px on the 1080-wide frame.

Safe areas: nothing is drawn in the top 14% (y < 270) or bottom 20% (y > 1536) of the 9:16. All
content, captions included, sits between y=320 and y=1280, so the 1:1 crop (1080 tall) holds it too.
The crop offsets are chosen from the measured extent of the content over every 0.1 s of the video
(not from constants); the 4:5 crop also keeps its content out of the bottom 10%.

## Scenes (mapped by script line id)

| Line | Scene |
|---|---|
| L1 | Hook: "Has your tenant handed in their notice?" and "We're <company>" |
| L2 | The short-term-let idea (photo or type only), with the area |
| L3 | With `figure`: the labelled example: big number, its unit, optional occupancy, and the WHOLE label sentence (never cropped, never under 34 px). Without: "Find out what yours could take home." |
| L4 | "No tenancy to get stuck in." and "You stay the owner.", plus `fee_sentence` when present |
| L5 | Website call to action |

A scene runs from 0.12 s before its line starts until the next scene starts (the first from 0, the last
to the end of the audio). 3 to 5 lines are accepted; a missing id drops its scene. The video is as long
as `audio` (measured with ffprobe), not as `script.duration`.

## brief.json (version 1): the contract between the TypeScript side and this renderer

UTF-8 JSON, written next to the assets:

    {
      "version": 1,
      "brand": { "company": str, "colour": "#RRGGBB", "logo": "<relative path or null>" },
      "photos": ["<relative path>", ... 0..4],      // already fetched; [] => type-only look
      "area": str, "bedrooms": int|null,
      "figure": null | { "label": str, "sentence": str, "gross": int|null, "net": int|null,
                         "takeHome": int|null, "occupancyPct": int|null,
                         "basis": "take-home"|"net"|"gross" },
      "fee_sentence": str|null,                     // e.g. "Our management fee is 12%." or null
      "script": {
        "lines": [ { "id": "L1".."L5", "text": str, "start": sec, "end": sec } ],  // in order, 3..5
        "words": [ { "text": str, "start": sec, "end": sec } ],                    // every spoken word
        "duration": sec
      },
      "audio": "<relative path to voice.mp3>",
      "out_dir": "<relative dir>"
    }

Details the renderer relies on:

* `brand.colour` must be 6-digit hex. `company` is cut to 80 characters (with an ellipsis).
* Figure: the big number is the one named by `basis` (take-home, net or gross; whole pounds a month, shown
  as `£1,850`). If that number is null the panel shows the label only. `label` is shown in full, as given.
  `occupancyPct` (0 to 100) adds "Typical occupancy: N%" when there is room. `sentence` is not drawn
  (it is what is spoken; the captions carry it).
* Text is cleaned before drawing: control characters and glyphs the bundled fonts lack (emoji, other
  scripts) are dropped. Latin, common punctuation, the pound and euro signs are kept.
* `lines[].start` must not decrease. `words` may be empty (no captions).
* Image formats: whatever Pillow opens (JPEG, PNG, WebP). Photos are scaled to cover, so any aspect
  ratio works.

## Output and errors

Into `out_dir`: `notice_9x16.mp4` (1080x1920, 30 fps), `notice_4x5.mp4` (1080x1350), `notice_1x1.mp4`
(1080x1080), `poster.png` (1080x1920). Exit code 0 only on success. On any failure: exactly one line
`ERR <code>` on stderr, a non-zero exit, no stack trace, and nothing from the brief printed:

| Code | Meaning |
|---|---|
| `bad_brief` | brief missing, not JSON, wrong version, a field of the wrong type or range, a path outside the brief's folder, or bad command line |
| `missing_asset` | a photo, the logo, the audio or a bundled font cannot be found or opened |
| `render_failed` | drawing failed, or the content did not fit the safe band |
| `ffmpeg_failed` | audio unreadable, ffmpeg or ffprobe missing or failed |

Set `AD_RENDER_DEBUG=1` to also get one `DEBUG <ExceptionType> line <n>` line (no message text).

## Files

`notice.py` (brief, scenes, captions), `video.py` (canvas, easing, ffmpeg), `theme.py` (colour maths,
fonts, text fitting), `components.py` (sprites), `fonts/`, `sample/` (generator and generated test
assets), `requirements.txt`. The repo test `src/lib/ad-packs/render-assets.test.ts` checks this folder
carries no third-party brand strings, figures or large binaries.
