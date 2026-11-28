"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  EMPTY_PROGRESS,
  GUIDE_STEPS,
  UPLOAD_STEP_ID,
  adProgressLabel,
  clampStep,
  copyListFor,
  guideStorageKey,
  nextAdToSetUp,
  nextStepIndex,
  nextWording,
  parseProgress,
  prevStepIndex,
  screenshotView,
  serializeProgress,
  stepNumberLabel,
  stepPercent,
  uploadHelp,
  withDone,
  withStep,
  wordingLabel,
  type GuideProgress,
  type GuideStep,
} from "@/lib/ad-packs/guide";
import { useAdsActions } from "../ActionsContext";
import { DownloadRow } from "../Downloads";
import { btnPrimary, btnPrimaryBase, btnSecondary, card, INK, SOFT } from "../ui";
import { ADS_PATH, type AdCopy, type CopyItem, type DownloadGroup } from "../view";

/**
 * Batch 38c: "Put your ads on Facebook", one small step on each screen.
 *
 *   1. Which ad are you setting up? (three cards with the picture)
 *   2. Thirteen steps (the audience step carries a numbered list of seven settings): a short instruction, the real Facebook screenshot (tap to make it bigger) and, for the
 *      text steps, the exact words with a big Copy button. Back and Next stick to the bottom of a phone.
 *   3. Done: "Set up my next ad".
 *
 * The step text is data (src/lib/ad-packs/guide.ts). The name, link and texts come from the ad itself and are
 * copied exactly as stored; pressing Copy logs the ad, the kind of text and which one (never the text). Where the
 * operator got to, for each ad, is kept in this browser only (no database).
 */

export type GuideAd = {
  id: string;
  heading: string;
  blurb: string;
  isVideo: boolean;
  /** One picture for the "which ad" cards (null: show a plain box). */
  cover: string | null;
  /** What the upload step previews: a picture ad's pictures, or the video's first frame. */
  previews: string[];
  /** How many pictures a picture ad has (0 for the video). */
  pictureCount: number;
  copy: AdCopy;
  downloads: DownloadGroup[];
};

const TOTAL = GUIDE_STEPS.length;

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private windows and blocked storage: the guide just starts at the first step next time.
  }
}

// ── Copy ──

type CopyState = "idle" | "copied" | "failed";

function legacyCopy(text: string): boolean {
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/** Clipboard first (inside the tap, so it is instant and allowed), then the log, which nobody waits for. */
function CopyButton({ adId, item, what }: { adId: string; item: CopyItem; what: string }) {
  const { recordCopy } = useAdsActions();
  const [state, setState] = useState<CopyState>("idle");

  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 2500);
    return () => clearTimeout(t);
  }, [state]);

  async function copy() {
    let ok = false;
    try {
      await navigator.clipboard.writeText(item.text);
      ok = true;
    } catch {
      ok = legacyCopy(item.text);
    }
    setState(ok ? "copied" : "failed");
    if (ok) void recordCopy(adId, item.kind, item.index).catch(() => undefined);
  }

  return (
    <button type="button" onClick={() => void copy()} aria-live="polite" className={`${btnPrimaryBase} w-full`}>
      {state === "copied" ? "Copied. Now paste it in Facebook." : state === "failed" ? "Press and hold the text above, then choose Copy" : `Copy ${what}`}
    </button>
  );
}

function CopyBlock({ adId, step, items, wording, onAnother }: { adId: string; step: GuideStep; items: CopyItem[]; wording: number; onAnother: () => void }) {
  if (items.length === 0) return null;
  const at = clampStep(wording, items.length);
  const item = items[at];
  const label = wordingLabel(at, items.length);
  const what = (step.ourName ?? item.label).toLowerCase();
  return (
    <section className={`${card} space-y-3`} aria-label={`Your ${what}`}>
      <p className={`text-base font-semibold ${INK}`}>
        Your {what}
        {label ? <span className={`font-normal ${SOFT}`}>{` · ${label}${at === 0 ? ", our suggestion" : ""}`}</span> : null}
      </p>
      <p className={`whitespace-pre-wrap break-words rounded-xl border border-border bg-white p-4 text-lg leading-relaxed ${INK} ${step.copy.kind === "link" || step.copy.kind === "ad_name" ? "break-all" : ""}`}>{item.text}</p>
      <CopyButton key={`${adId}-${item.key}`} adId={adId} item={item} what={what} />
      {items.length > 1 ? (
        <button type="button" onClick={onAnother} className={`${btnSecondary} w-full`}>
          Show me another wording
        </button>
      ) : null}
    </section>
  );
}

// ── Screenshot, tap to make it bigger ──

function Shot({ step, shots }: { step: GuideStep; shots: string[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pic = screenshotView(step, shots);
  if (pic.kind !== "image") {
    return <p className={`rounded-xl border-2 border-dashed border-border p-4 text-base ${SOFT}`}>{pic.text}</p>;
  }
  return (
    <figure className="space-y-2">
      <button type="button" onClick={() => dialog.current?.showModal()} className="block min-h-11 w-full rounded-xl border border-border bg-white p-2" aria-label={`${pic.alt}. Tap to make it bigger.`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a fixed screenshot from /public */}
        <img src={pic.src} alt={pic.alt} className="mx-auto max-h-80 w-auto max-w-full rounded-lg object-contain" loading="lazy" />
      </button>
      <figcaption className={`text-center text-base ${SOFT}`}>This is what you will see in Facebook. Tap the picture to make it bigger.</figcaption>
      <dialog
        ref={dialog}
        onClick={(e) => {
          if (e.target === dialog.current) dialog.current?.close();
        }}
        className="fixed inset-0 m-auto max-h-[92vh] w-[min(94vw,52rem)] overflow-auto rounded-2xl bg-white p-3 backdrop:bg-black/70"
      >
        <button type="button" onClick={() => dialog.current?.close()} className={btnPrimary}>
          Close
        </button>
        {/* eslint-disable-next-line @next/next/no-img-element -- the same screenshot, larger */}
        <img src={pic.src} alt={pic.alt} className="mx-auto mt-3 w-full max-w-2xl rounded-lg" />
      </dialog>
    </figure>
  );
}

// ── The upload step: which file to download ──

function UploadBlock({ ad }: { ad: GuideAd }) {
  const [first, ...others] = ad.downloads;
  const noun = ad.isVideo ? "video" : "picture";
  return (
    <section className={`${card} space-y-4`} aria-label="The file for this ad">
      <p className={`text-base leading-relaxed ${INK}`}>{uploadHelp(ad.isVideo, ad.pictureCount)}</p>
      {ad.previews.length > 0 ? (
        <ul className="flex gap-2 overflow-x-auto pb-1" aria-label="Preview">
          {ad.previews.map((src, i) => (
            <li key={src} className="w-20 shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element -- a private picture behind a signed link */}
              <img src={src} alt={ad.isVideo ? "First frame of your video" : `Picture ${i + 1}`} className={`w-full rounded-lg border border-border object-cover ${ad.isVideo ? "aspect-[9/16]" : "aspect-[4/5]"}`} loading="lazy" />
            </li>
          ))}
        </ul>
      ) : null}
      {first ? <DownloadRow adId={ad.id} group={first} noun={noun} big /> : <p className={`text-base ${SOFT}`}>Your files are not ready yet.</p>}
      {others.length > 0 ? (
        <details>
          <summary className={`flex min-h-11 cursor-pointer items-center text-base font-semibold ${INK}`}>Need another size?</summary>
          <div className="mt-2 space-y-3">
            {others.map((g) => <DownloadRow key={g.key} adId={ad.id} group={g} noun={noun} />)}
          </div>
        </details>
      ) : null}
    </section>
  );
}

// ── The wizard ──

type Phase = "pick" | "step" | "done";

/** `initial` is only for the development preview, to open a particular screen; the real page never passes it. */
export function GuideWizard({ ads, shots, packId, initial, audienceChecklist }: { ads: GuideAd[]; shots: string[]; packId: string; initial?: { phase: Phase; adId?: string; index?: number }; /** Batch 55 step 5 (Phase 3): the lead database pack's own audience lines (its location); absent, the step's own. */ audienceChecklist?: string[] }) {
  const adIds = ads.map((a) => a.id);
  const key = guideStorageKey(packId);
  const [phase, setPhase] = useState<Phase>(initial?.phase ?? "pick");
  const [adId, setAdId] = useState<string>(initial?.adId ?? ads[0]?.id ?? "");
  const [index, setIndex] = useState(initial?.index ?? 0);
  const [progress, setProgress] = useState<GuideProgress>(EMPTY_PROGRESS);
  const [wording, setWording] = useState<Record<string, number>>({});
  const moved = useRef(false);

  // What was done before on this phone (the browser's own memory, so only after the first paint).
  useEffect(() => {
    setProgress(parseProgress(readStored(key), adIds, TOTAL)); // eslint-disable-line react-hooks/set-state-in-effect -- reading browser storage is only possible after mount
    // eslint-disable-next-line react-hooks/exhaustive-deps -- adIds is rebuilt every render; the key is what changes
  }, [key]);

  // After the screen changes, bring the top into view (a phone screen is short).
  useEffect(() => {
    if (moved.current) window.scrollTo({ top: 0, behavior: "smooth" });
  }, [phase, index, adId]);

  function remember(next: GuideProgress) {
    setProgress(next);
    writeStored(key, serializeProgress(next));
  }

  function choose(id: string) {
    moved.current = true;
    const saved = progress.ads[id];
    const at = saved && !saved.done ? saved.step : 0;
    setAdId(id);
    setIndex(at);
    setPhase("step");
    remember(withStep(progress, id, at, TOTAL));
  }

  function go(next: number) {
    moved.current = true;
    setIndex(next);
    remember(withStep(progress, adId, next, TOTAL));
  }

  function finish() {
    moved.current = true;
    setPhase("done");
    remember(withDone(progress, adId, TOTAL));
  }

  const ad = ads.find((a) => a.id === adId) ?? ads[0] ?? null;
  if (!ad) {
    return <p className={`text-lg ${INK}`}>Your ads are not ready yet.</p>;
  }

  // ── 1. Which ad ──
  if (phase === "pick") {
    return (
      <section className="space-y-4">
        <div>
          <h2 className={`text-2xl font-bold ${INK}`}>Which ad are you setting up?</h2>
          <p className={`mt-1 text-lg leading-relaxed ${SOFT}`}>Do one ad at a time. We remember where you got to on this phone, and we never touch your Facebook account.</p>
        </div>
        <ul className="space-y-3">
          {ads.map((a) => (
            <li key={a.id}>
              <button type="button" onClick={() => choose(a.id)} className="flex min-h-24 w-full items-center gap-4 rounded-2xl border-2 border-border bg-card p-3 text-left transition active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#233221]">
                {a.cover ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a private picture behind a signed link
                  <img src={a.cover} alt="" className={`h-20 w-16 shrink-0 rounded-lg border border-border object-cover`} />
                ) : (
                  <span aria-hidden className="h-20 w-16 shrink-0 rounded-lg border-2 border-dashed border-border" />
                )}
                <span className="min-w-0">
                  <span className={`block text-lg font-bold leading-snug ${INK}`}>{a.heading}</span>
                  <span className={`mt-0.5 block text-base ${SOFT}`}>{adProgressLabel(progress, a.id, TOTAL)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  // ── 3. Done ──
  if (phase === "done") {
    const next = nextAdToSetUp(progress, adIds, ad.id);
    const nextAd = next ? ads.find((a) => a.id === next) : null;
    return (
      <section className={`${card} space-y-4`}>
        <h2 className={`text-2xl font-bold ${INK}`}>{ad.heading} is on its way</h2>
        <p className={`text-lg leading-relaxed ${INK}`}>Facebook looks at every ad before it goes live. This can take up to a day, and Facebook tells you when it is approved.</p>
        {nextAd ? (
          <>
            <p className={`text-base ${SOFT}`}>Next up: {nextAd.heading}</p>
            <button type="button" onClick={() => choose(nextAd.id)} className={btnPrimary}>
              Set up my next ad
            </button>
          </>
        ) : (
          <p className={`text-lg font-semibold ${INK}`}>All three ads are done. Well done.</p>
        )}
        <Link href={ADS_PATH} className={`${btnSecondary} w-full sm:w-auto`}>
          Back to my ads
        </Link>
      </section>
    );
  }

  // ── 2. A step ──
  const i = clampStep(index, TOTAL);
  const step = GUIDE_STEPS[i];
  const checklist = step.id === "set-audience" && audienceChecklist ? audienceChecklist : step.checklist;
  const items = copyListFor(step.copy.kind, ad.copy);
  const wordingKey = `${ad.id}:${step.copy.kind}`;
  const last = i === TOTAL - 1;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <p className={`text-base font-semibold leading-snug ${INK}`}>{ad.heading}</p>
        <button type="button" onClick={() => { moved.current = true; setPhase("pick"); }} className={`min-h-11 shrink-0 px-1 text-base font-medium underline underline-offset-4 ${INK}`}>
          Change ad
        </button>
      </div>

      <div>
        <p className={`text-lg font-bold ${INK}`}>{stepNumberLabel(i, TOTAL)}</p>
        <div className="mt-2 h-3 w-full overflow-hidden rounded-full bg-[#3b5735]/20" role="progressbar" aria-valuemin={1} aria-valuemax={TOTAL} aria-valuenow={i + 1} aria-valuetext={`${stepNumberLabel(i, TOTAL)}: ${step.title}`} aria-label="Your progress">
          <div className="h-full rounded-full bg-[#3b5735] transition-all" style={{ width: `${stepPercent(i, TOTAL)}%` }} />
        </div>
      </div>

      <div aria-live="polite">
        <h2 className={`text-2xl font-bold leading-snug ${INK}`}>{step.action}</h2>
        {step.detail ? <p className={`mt-2 text-lg leading-relaxed ${SOFT}`}>{step.detail}</p> : null}
        {checklist ? (
          <ol className={`mt-3 list-decimal space-y-2 pl-6 text-lg leading-relaxed ${INK}`}>
            {checklist.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
        ) : null}
      </div>

      {step.id === UPLOAD_STEP_ID ? <UploadBlock ad={ad} /> : null}

      <CopyBlock adId={ad.id} step={step} items={items} wording={wording[wordingKey] ?? 0} onAnother={() => setWording((w) => ({ ...w, [wordingKey]: nextWording(w[wordingKey] ?? 0, items.length) }))} />

      <Shot step={step} shots={shots} />

      <details className="rounded-2xl border border-border bg-card px-4 py-1">
        <summary className={`flex min-h-12 cursor-pointer items-center text-base font-semibold ${INK}`}>I am stuck</summary>
        <p className={`pb-3 text-base leading-relaxed ${INK}`}>{step.stuck}</p>
      </details>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-6px_18px_rgba(35,50,33,0.12)] sm:static sm:z-auto sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none">
        <div className="mx-auto flex max-w-4xl gap-3">
          <button type="button" onClick={() => (i === 0 ? setPhase("pick") : go(prevStepIndex(i, TOTAL)))} className={`${btnSecondary} flex-1`}>
            Back
          </button>
          {last ? (
            <button type="button" onClick={finish} className={`${btnPrimaryBase} flex-[2]`}>
              I have published it
            </button>
          ) : (
            <button type="button" onClick={() => go(nextStepIndex(i, TOTAL))} className={`${btnPrimaryBase} flex-[2]`}>
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
