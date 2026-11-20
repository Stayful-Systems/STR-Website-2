"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { GUIDE_STEPS, clampStep, copyListFor, needsAdPicker, nextStepIndex, prevStepIndex, screenshotView, stepNumberLabel, uploadHint } from "@/lib/ad-packs/guide";
import { TextRow } from "./AdPackClient";
import type { AdCopy } from "./view";

/**
 * Batch 38 (Phase 9): the setup guide, one action per screen. The step text is
 * data (src/lib/ad-packs/guide.ts); this file only lays it out. The name, link
 * and texts come from the pack itself through the same copy buttons as the ad
 * sections above (they log `ad_text_copied`). Where the operator got to is kept
 * in this browser only (no database). The section around it in page.tsx carries
 * id="guide", so /leads/ads#guide opens straight to it.
 */

export type GuideAd = { id: string; title: string; /** The notice ad is a video; the other two are images. */ isVideo: boolean; copy: AdCopy };

const TOTAL = GUIDE_STEPS.length;

function readSaved(key: string): number {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? 0 : clampStep(Number(raw), TOTAL);
  } catch {
    return 0;
  }
}

function save(key: string, i: number): void {
  try {
    window.localStorage.setItem(key, String(i));
  } catch {
    // Private windows and blocked storage: the guide just starts at the first step next time.
  }
}

export function Guide({ ads, shots, storageKey }: { ads: GuideAd[]; shots: string[]; storageKey: string }) {
  const [index, setIndex] = useState(0);
  const [adId, setAdId] = useState(ads[0]?.id ?? "");
  const top = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  const key = `ad-guide-step:${storageKey}`;

  // Pick up where the operator left off (the browser's own memory, so only after the first paint).
  useEffect(() => {
    const saved = readSaved(key);
    if (saved > 0) setIndex(saved); // eslint-disable-line react-hooks/set-state-in-effect -- reading browser storage is only possible after mount
  }, [key]);

  // After a Next or Back press, bring the top of the step into view (a phone screen is short).
  useEffect(() => {
    if (!moved.current) return;
    top.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [index]);

  function go(next: number) {
    moved.current = true;
    setIndex(next);
    save(key, next);
  }

  const i = clampStep(index, TOTAL);
  const step = GUIDE_STEPS[i];
  const ad = ads.find((a) => a.id === adId) ?? ads[0] ?? null;
  const items = ad ? copyListFor(step.copy.kind, ad.copy) : [];
  const pic = screenshotView(step, shots);
  const percent = Math.round(((i + 1) / TOTAL) * 100);

  return (
    <div ref={top} className="scroll-mt-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-foreground">{stepNumberLabel(i, TOTAL)}</p>
        <p className="text-xs text-muted-foreground">{step.title}</p>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={1} aria-valuemax={TOTAL} aria-valuenow={i + 1} aria-label="Guide progress">
        <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
      </div>

      <div className="mt-5" aria-live="polite">
        <h3 className="text-xl font-semibold leading-snug text-foreground sm:text-2xl">{step.action}</h3>
        {step.detail ? <p className="mt-2 text-sm text-muted-foreground">{step.detail}</p> : null}
      </div>

      {needsAdPicker(step) && ads.length > 0 ? (
        <div className="mt-5">
          <p className="text-xs font-medium text-muted-foreground">Which ad are you setting up?</p>
          <div className="mt-1.5 flex flex-wrap gap-2" role="group" aria-label="Choose an ad">
            {ads.map((a) => (
              <Button key={a.id} type="button" size="sm" variant={a.id === ad?.id ? "default" : "outline"} aria-pressed={a.id === ad?.id} onClick={() => setAdId(a.id)}>
                {a.title}
              </Button>
            ))}
          </div>
          {ad && step.id === "upload-file" ? (
            <p className="mt-2 rounded-md border border-border bg-muted/40 p-2.5 text-xs text-muted-foreground">{uploadHint(ad.isVideo)}</p>
          ) : null}
        </div>
      ) : null}

      {items.length > 0 && ad ? (
        <ul className="mt-4 space-y-2">
          {items.map((item) => <TextRow key={`${ad.id}-${item.key}`} adId={ad.id} item={item} canCopy />)}
        </ul>
      ) : null}

      <figure className="mt-5">
        {pic.kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element -- a fixed screenshot from /public, already cropped to 1200px wide
          <img src={pic.src} alt={pic.alt} className="w-full rounded-lg border border-border" loading="lazy" />
        ) : (
          <div className="flex min-h-32 items-center justify-center rounded-lg border border-dashed border-border bg-muted/40 p-4 text-center text-sm text-muted-foreground">{pic.text}</div>
        )}
      </figure>

      <details className="mt-5 rounded-lg border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium text-foreground">Stuck?</summary>
        <p className="mt-2 text-sm text-muted-foreground">{step.stuck}</p>
      </details>

      <div className="mt-6 flex items-center justify-between gap-3 border-t border-border pt-4">
        <Button type="button" variant="outline" disabled={i === 0} onClick={() => go(prevStepIndex(i, TOTAL))}>Back</Button>
        {i < TOTAL - 1 ? (
          <Button type="button" onClick={() => go(nextStepIndex(i, TOTAL))}>Next</Button>
        ) : (
          <Button type="button" variant="outline" onClick={() => go(0)}>Start again</Button>
        )}
      </div>
    </div>
  );
}
