"use client";

import { useActionState, useRef, useState } from "react";
import { DEFAULT_VOICE_KEY, type VoiceKey } from "@/lib/ad-packs/voices";
import { useAdsActions } from "./ActionsContext";
import type { AdsState } from "./ops";
import { VoicePicker } from "./VoicePicker";
import { CoveragePicker, type CoveragePickerProps } from "./CoveragePicker";
import { Alert, btnPrimary, btnSecondary, Calm, card, fieldCls, INK, SOFT, StickyBar } from "./ui";
import { AREA_HINT, AREA_LABEL, AREA_PLACEHOLDER, areaPreviewView, MAKING_ADS_TEXT, NO_LOGO_TEXT, PHOTOS_HELP, PHOTOS_TITLE, REGEN_BUTTON, START_BUTTON, START_BUTTON_AGAIN, VOICE_STEP_HELP, VOICE_STEP_TITLE, type AreaPreviewView } from "./view";

/**
 * Batch 38c: the form that makes the ads. For a first time it asks three small
 * things: where to find landlords, which voice, and (hidden until asked for)
 * their own photos; plus one tick only when the website has no logo. The main
 * button sticks to the bottom of a phone. Made again later (under "More options")
 * it asks the same, without the voice. Every rule is enforced in ops.ts; this
 * file only lays the form out.
 */

const INITIAL: AdsState = {};
const MAX_PHOTOS = 4;
// A phone photo is often 3 to 8 MB; a server action carries 1 MB by default. A big photo is scaled down in the browser first.
const SEND_LIMIT = 800 * 1024;

export type PhotoItem = { ref: string; url: string | null };

/** Scale a big photo down to something a server action can carry; a small one, or one the browser cannot read, goes as it is. */
async function shrinkIfNeeded(file: File): Promise<File> {
  if (file.size <= SEND_LIMIT) return file;
  try {
    const bitmap = await createImageBitmap(file);
    let longest = 1800;
    let quality = 0.85;
    for (let i = 0; i < 6; i++) {
      const scale = Math.min(1, longest / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) break;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (blob && blob.size <= SEND_LIMIT) return new File([blob], "photo.jpg", { type: "image/jpeg" });
      quality = Math.max(0.4, quality - 0.1);
      longest = Math.round(longest * 0.8);
    }
  } catch {
    /* fall through: send it as it is and let the server say if it is too big */
  }
  return file;
}

export interface StartFormProps {
  /** "start" is the first time; "again" is making new ads from "More options". */
  mode: "start" | "again";
  /** The owner's ads, when making new ones. Only a lookup key: the server checks it is theirs. */
  packId: string | null;
  areas: { areaKey: string; label: string }[];
  initialAreaKey: string | null;
  initialAreaPreview: AreaPreviewView | null;
  initialPhotos: PhotoItem[];
  /** The website has a logo: no need to ask about showing the company name instead. */
  hasLogo: boolean;
  /** Things the operator cannot fix here, in plain sentences. The button is off while there are any. */
  problems: string[];
  /** Lead database route: where the operator fixes those problems themselves (their calculator page). */
  problemLink?: { href: string; label: string } | null;
  /** A first try that did not work. */
  failedBefore?: boolean;
  /** Making new ads only: why that is not possible right now (shown instead of the button unless the place or photos were changed). */
  blockReason?: string | null;
  /**
   * Batch 55 step 5 (Phase 3), the lead database route only: "Anywhere in the UK" or "Choose areas" replaces the one
   * place list. Absent (the Academy), the form is exactly as before.
   */
  coverage?: Omit<CoveragePickerProps, "formId" | "onState">;
}

export function StartForm(p: StartFormProps) {
  const { generate, areaPreview, uploadPhoto } = useAdsActions();
  const [state, action, pending] = useActionState(generate, INITIAL);
  const [areaKey, setAreaKey] = useState(p.initialAreaKey ?? "");
  const [preview, setPreview] = useState<AreaPreviewView | null>(p.initialAreaPreview);
  const [photos, setPhotos] = useState<PhotoItem[]>(p.initialPhotos);
  const [uploading, setUploading] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [typeOnly, setTypeOnly] = useState(true);
  const [voiceKey, setVoiceKey] = useState<VoiceKey>(DEFAULT_VOICE_KEY);
  const asked = useRef(0);
  const again = p.mode === "again";
  const [coverageState, setCoverageState] = useState({ ready: true, dirty: false });
  const usesCoverage = p.coverage !== undefined;

  async function pickArea(next: string) {
    setAreaKey(next);
    if (!next) {
      setPreview(null);
      return;
    }
    const mine = ++asked.current;
    setPreview(null);
    try {
      const view = await areaPreview(next);
      if (mine === asked.current) setPreview(view);
    } catch {
      if (mine === asked.current) setPreview(areaPreviewView({ error: "not_enough_data" }));
    }
  }

  async function addPhotos(files: FileList | null) {
    if (!files || files.length === 0) return;
    setPhotoError(null);
    setUploading(true);
    let list = photos;
    try {
      for (const original of Array.from(files)) {
        if (list.length >= MAX_PHOTOS) {
          setPhotoError("You can use up to 4 photos.");
          break;
        }
        const file = await shrinkIfNeeded(original);
        const body = new FormData();
        body.set("photo", file);
        try {
          const out = await uploadPhoto(body);
          if (!out.ok) {
            setPhotoError(out.error);
            continue;
          }
          list = [...list, { ref: out.ref, url: out.previewUrl }];
          setPhotos(list);
        } catch {
          setPhotoError("That photo could not be sent. Please try a smaller one.");
        }
      }
    } finally {
      setUploading(false);
    }
  }

  const dirty = (usesCoverage ? coverageState.dirty : areaKey !== (p.initialAreaKey ?? "")) || photos.map((x) => x.ref).join("|") !== p.initialPhotos.map((x) => x.ref).join("|");
  const hidden = again && (p.blockReason ?? null) !== null && !dirty;
  const blocked = p.problems.length > 0 || (usesCoverage ? !coverageState.ready : !areaKey || !preview?.ok) || uploading || (!p.hasLogo && !typeOnly);
  const button = pending ? "Making your ads…" : again ? REGEN_BUTTON : p.failedBefore ? START_BUTTON_AGAIN : START_BUTTON;

  const submit = (
    <>
      {pending ? <Calm>{MAKING_ADS_TEXT}</Calm> : null}
      <button type="submit" disabled={pending || blocked} className={btnPrimary}>
        {button}
      </button>
    </>
  );

  return (
    <form action={action} className="space-y-5">
      {p.packId ? <input type="hidden" name="packId" value={p.packId} /> : null}
      {photos.map((x) => <input key={x.ref} type="hidden" name="photoRef" value={x.ref} />)}

      {p.coverage ? <CoveragePicker {...p.coverage} formId={p.mode} onState={setCoverageState} /> : (
      <section className={card}>
        <label htmlFor={`${p.mode}-area`} className={`block text-xl font-bold ${INK}`}>{AREA_LABEL}</label>
        <select id={`${p.mode}-area`} name="areaKey" value={areaKey} onChange={(e) => void pickArea(e.target.value)} className={fieldCls} required>
          {areaKey === "" ? <option value="">{AREA_PLACEHOLDER}</option> : null}
          {p.areas.map((a) => <option key={a.areaKey} value={a.areaKey}>{a.label}</option>)}
        </select>
        <p className={`mt-3 text-base leading-relaxed ${SOFT}`} aria-live="polite">
          {!areaKey ? AREA_HINT : preview ? preview.text : "Checking that place…"}
        </p>
      </section>
      )}

      {again ? null : (
        <section className={`${card} min-w-0`} aria-labelledby="voice-title">
          <h2 id="voice-title" className={`text-xl font-bold ${INK}`}>{VOICE_STEP_TITLE}</h2>
          <p className={`mb-3 mt-1 text-base ${SOFT}`}>{VOICE_STEP_HELP}</p>
          <VoicePicker name="voiceKey" value={voiceKey} onChange={setVoiceKey} />
        </section>
      )}

      <details className={`${card} group`} open={photos.length > 0}>
        <summary className={`flex min-h-11 cursor-pointer items-center text-lg font-semibold ${INK}`}>{PHOTOS_TITLE}</summary>
        <div className="mt-3">
          <p className={`text-base leading-relaxed ${SOFT}`}>{PHOTOS_HELP}</p>
          {photos.length > 0 ? (
            <ul className="mt-3 grid grid-cols-2 gap-3">
              {photos.map((x) => (
                <li key={x.ref} className="overflow-hidden rounded-xl border border-border bg-muted">
                  {x.url ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a private photo behind a signed link: never through the image optimiser
                    <img src={x.url} alt="One of your photos" className="aspect-square w-full object-cover" />
                  ) : (
                    <div className={`flex aspect-square items-center justify-center text-base ${SOFT}`}>Photo saved</div>
                  )}
                  <button type="button" onClick={() => setPhotos((l) => l.filter((y) => y.ref !== x.ref))} className="min-h-11 w-full border-t border-border bg-card text-base font-semibold text-[#2c4727]" aria-label="Remove this photo">
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {photos.length < MAX_PHOTOS ? (
            <label className={`${btnSecondary} mt-3 w-full cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2`}>
              {uploading ? "Adding…" : photos.length === 0 ? "Choose photos" : "Add another photo"}
              <input type="file" accept="image/jpeg,image/png" multiple className="sr-only" disabled={uploading || pending} onChange={(e) => { void addPhotos(e.target.files); e.target.value = ""; }} />
            </label>
          ) : null}
          {photoError ? <div className="mt-3"><Alert>{photoError}</Alert></div> : null}
        </div>
      </details>

      {!p.hasLogo ? (
        <label className={`${card} flex min-h-14 cursor-pointer items-start gap-3`}>
          <input type="checkbox" name="typeOnly" checked={typeOnly} onChange={(e) => setTypeOnly(e.target.checked)} className="mt-1 size-6 shrink-0 accent-[#3b5735]" />
          <span className={`text-base leading-relaxed ${INK}`}>{NO_LOGO_TEXT}</span>
        </label>
      ) : null}

      {p.problems.map((t) => <Alert key={t}>{t}</Alert>)}
      {p.problems.length > 0 && p.problemLink ? (
        <a href={p.problemLink.href} className={`${btnSecondary} inline-flex w-full items-center justify-center sm:w-auto`}>
          {p.problemLink.label}
        </a>
      ) : null}
      {state.error ? <Alert>{state.error}</Alert> : null}

      {hidden ? <Calm live={false}>{p.blockReason}</Calm> : again ? <div className="space-y-3">{submit}</div> : <StickyBar>{submit}</StickyBar>}
    </form>
  );
}
