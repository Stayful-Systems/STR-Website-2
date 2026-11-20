"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { approvePackAction, areaPreviewAction, downloadFileAction, generatePackAction, recordCopyAction, uploadPhotoAction } from "./actions";
import type { AdsState } from "./ops";
import { areaPreviewView, NO_LOGO_TEXT, type AdCopy, type AreaPreviewView, type CopyItem, type LengthView } from "./view";

/**
 * Batch 36 (Phase 8): the interactive parts of the ad pack screen. The page
 * (a server component) reads everything and passes plain data; this file only
 * lays out the form, the copy buttons and the download buttons. Every rule
 * (who may do what, which length is green) lives in ops.ts and view.ts.
 */

const INITIAL: AdsState = {};
const MAX_PHOTOS = 4;
// A phone photo is often 3 to 8 MB; a server action carries 1 MB by default. A big photo is scaled down in the browser first.
const SEND_LIMIT = 800 * 1024;

const card = "rounded-xl border border-border bg-card p-4 sm:p-5";
const field = "mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground";

function Alert({ children }: { children: React.ReactNode }) {
  return <p role="alert" className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{children}</p>;
}

// ── Photos ──

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

// ── The form: confirm your area, add photos, make the ads ──

export interface GenerateFormProps {
  mode: "start" | "regenerate";
  /** The owner's pack, when this is a regenerate. Only a lookup key: the server checks it is theirs. */
  packId: string | null;
  areas: { areaKey: string; label: string }[];
  initialAreaKey: string | null;
  initialAreaPreview: AreaPreviewView | null;
  initialPhotos: PhotoItem[];
  /** The website has a logo: no need to ask about type-only ads. */
  hasLogo: boolean;
  brand: { company: string; colour: string | null; logoUrl: string | null; fee: string | null };
  /** Things the operator cannot fix here, in plain sentences. Generate is off while there are any. */
  problems: string[];
  /** Regenerate only: why Regenerate is not offered right now (shown unless the area or photos have been changed). */
  blockReason: string | null;
  freeLeft?: number;
  failedBefore?: boolean;
}

export function GenerateForm(p: GenerateFormProps) {
  const [state, action, pending] = useActionState(generatePackAction, INITIAL);
  const [areaKey, setAreaKey] = useState(p.initialAreaKey ?? "");
  const [preview, setPreview] = useState<AreaPreviewView | null>(p.initialAreaPreview);
  const [photos, setPhotos] = useState<PhotoItem[]>(p.initialPhotos);
  const [uploading, setUploading] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [typeOnly, setTypeOnly] = useState(false);
  const asked = useRef(0);

  async function pickArea(next: string) {
    setAreaKey(next);
    if (!next) {
      setPreview(null);
      return;
    }
    const mine = ++asked.current;
    setPreview(null);
    try {
      const view = await areaPreviewAction(next);
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
          setPhotoError("A pack can use up to 4 photos.");
          break;
        }
        const file = await shrinkIfNeeded(original);
        const body = new FormData();
        body.set("photo", file);
        try {
          const out = await uploadPhotoAction(body);
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

  const dirty = areaKey !== (p.initialAreaKey ?? "") || photos.map((x) => x.ref).join("|") !== p.initialPhotos.map((x) => x.ref).join("|");
  const regenerate = p.mode === "regenerate";
  const hidden = regenerate && p.blockReason !== null && !dirty;
  const blocked = p.problems.length > 0 || !areaKey || !preview?.ok || uploading || (!p.hasLogo && !typeOnly);

  return (
    <form action={action} className={`${card} space-y-5`}>
      {p.packId ? <input type="hidden" name="packId" value={p.packId} /> : null}
      {photos.map((x) => <input key={x.ref} type="hidden" name="photoRef" value={x.ref} />)}

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className="inline-block size-4 rounded-full border border-border" style={p.brand.colour ? { backgroundColor: p.brand.colour } : undefined} />
          <span className="font-medium text-foreground">{p.brand.company || "Your company"}</span>
        </span>
        <span className="text-xs text-muted-foreground">
          {p.brand.fee ? `Your fee: ${p.brand.fee}` : "No fee shown on your ads"}
        </span>
      </div>

      <label className="block">
        <span className="text-sm font-medium text-foreground">{regenerate ? "Your main area" : "Confirm your main area"}</span>
        <select name="areaKey" value={areaKey} onChange={(e) => void pickArea(e.target.value)} className={field} required>
          {areaKey === "" ? <option value="">Choose your area</option> : null}
          {p.areas.map((a) => <option key={a.areaKey} value={a.areaKey}>{a.label}</option>)}
        </select>
      </label>
      <div className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground" aria-live="polite">
        {!areaKey ? "Choose the area your landlords are in." : preview ? preview.text : "Checking that area…"}
      </div>

      <div>
        <p className="text-sm font-medium text-foreground">Your photos <span className="font-normal text-muted-foreground">(optional, up to 4)</span></p>
        <p className="mt-0.5 text-xs text-muted-foreground">JPG or PNG. We put them behind the words on your ads. Without photos your ads use your colour and logo.</p>
        {photos.length > 0 ? (
          <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {photos.map((x) => (
              <li key={x.ref} className="relative overflow-hidden rounded-md border border-border bg-muted">
                {x.url ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a private photo behind a signed link: never through the image optimiser
                  <img src={x.url} alt="One of your photos" className="aspect-square w-full object-cover" />
                ) : (
                  <div className="flex aspect-square items-center justify-center text-xs text-muted-foreground">Photo saved</div>
                )}
                <button type="button" onClick={() => setPhotos((l) => l.filter((y) => y.ref !== x.ref))} className="absolute right-1 top-1 rounded bg-background/90 px-2 py-1 text-xs font-medium text-foreground shadow hover:bg-background" aria-label="Remove this photo">
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {photos.length < MAX_PHOTOS ? (
          <label className="mt-3 inline-flex cursor-pointer items-center rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted">
            {uploading ? "Adding…" : photos.length === 0 ? "Add photos" : "Add another photo"}
            <input type="file" accept="image/jpeg,image/png" multiple className="sr-only" disabled={uploading || pending} onChange={(e) => { void addPhotos(e.target.files); e.target.value = ""; }} />
          </label>
        ) : null}
        {photoError ? <Alert>{photoError}</Alert> : null}
      </div>

      {!p.hasLogo ? (
        <label className="flex items-start gap-3 rounded-md border border-border p-3 text-sm">
          <input type="checkbox" name="typeOnly" checked={typeOnly} onChange={(e) => setTypeOnly(e.target.checked)} className="mt-1 size-4" />
          <span>
            <span className="font-medium text-foreground">Use my company name in type</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">{NO_LOGO_TEXT}</span>
          </span>
        </label>
      ) : null}

      {p.problems.map((t) => <Alert key={t}>{t}</Alert>)}
      {state.error ? <Alert>{state.error}</Alert> : null}

      {hidden ? (
        <p className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">{p.blockReason}</p>
      ) : (
        <div className="space-y-2">
          <Button type="submit" size="lg" disabled={pending || blocked} className="h-11 w-full text-base sm:w-auto sm:px-6">
            {pending ? "Making your ads…" : regenerate ? "Regenerate my ads" : p.failedBefore ? "Try again" : "Make my ads"}
          </Button>
          {pending ? <p role="status" className="text-sm text-muted-foreground">This can take a minute or two. Please keep this page open.</p> : null}
          {regenerate && p.freeLeft !== undefined ? <p className="text-xs text-muted-foreground">You have {p.freeLeft} free {p.freeLeft === 1 ? "regeneration" : "regenerations"} left. Your old ad codes keep working.</p> : null}
        </div>
      )}
    </form>
  );
}

// ── Approve ──

export function ApproveForm({ packId }: { packId: string }) {
  const [state, action, pending] = useActionState(approvePackAction, INITIAL);
  return (
    <form action={action} className={`${card} space-y-3`}>
      <input type="hidden" name="packId" value={packId} />
      <p className="text-sm text-foreground">Happy with them? Approve your ads to get the image files and every text to copy.</p>
      <Button type="submit" size="lg" disabled={pending} className="h-11 w-full text-base sm:w-auto sm:px-6">{pending ? "Approving…" : "Approve my ads"}</Button>
      {state.error ? <Alert>{state.error}</Alert> : null}
    </form>
  );
}

// ── Copy ──

type CopyState = "idle" | "copied" | "failed";

/** Clipboard first (inside the tap, so it is instant and allowed), then the log, which nobody waits for. */
function CopyButton({ adId, item }: { adId: string; item: CopyItem }) {
  const [state, setState] = useState<CopyState>("idle");

  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 2000);
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
    if (ok) void recordCopyAction(adId, item.kind, item.index).catch(() => undefined);
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={() => void copy()} aria-live="polite" className="shrink-0">
      {state === "copied" ? "Copied" : state === "failed" ? "Select and copy" : "Copy"}
    </Button>
  );
}

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

function Indicator({ v }: { v: LengthView }) {
  return (
    <div className="mt-1.5 space-y-0.5 text-xs">
      <p className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 font-medium ${v.badge}`}>{v.word}</span>
        <span className="text-muted-foreground">{v.counter}</span>
      </p>
      <p className="text-muted-foreground">{v.limits}</p>
      {v.notes.map((n) => <p key={n} className="text-muted-foreground">{n}</p>)}
    </div>
  );
}

export function TextRow({ adId, item, canCopy }: { adId: string; item: CopyItem; canCopy: boolean }) {
  return (
    <li className="rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground">{item.label}</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">{item.text}</p>
        </div>
        {canCopy ? <CopyButton adId={adId} item={item} /> : null}
      </div>
      {item.length ? <Indicator v={item.length} /> : null}
    </li>
  );
}

/** One ad's name, link and texts. In a preview they are listed; once approved each has a Copy button. */
export function AdTexts({ adId, copy, canCopy }: { adId: string; copy: AdCopy; canCopy: boolean }) {
  const groups: { title: string; items: CopyItem[] }[] = [
    { title: "Names and link", items: [copy.name, copy.link] },
    { title: "Primary text", items: copy.primary },
    { title: "Headlines", items: copy.headlines },
    { title: "Descriptions", items: copy.descriptions },
  ];
  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <section key={g.title}>
          <h4 className="text-sm font-semibold text-foreground">{g.title}</h4>
          <ul className="mt-2 space-y-2">
            {g.items.map((item) => <TextRow key={item.key} adId={adId} item={item} canCopy={canCopy} />)}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ── Download ──

export function DownloadButton({ adId, fileName, label }: { adId: string; fileName: string; label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const out = await downloadFileAction(adId, fileName);
      if (!out.ok) {
        setError(out.error);
        return;
      }
      const a = document.createElement("a");
      a.href = out.url;
      a.download = fileName;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch {
      setError("We could not make that download link. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col">
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void download()}>{busy ? "Getting it…" : label}</Button>
      {error ? <span role="alert" className="mt-1 text-xs text-destructive">{error}</span> : null}
    </span>
  );
}
