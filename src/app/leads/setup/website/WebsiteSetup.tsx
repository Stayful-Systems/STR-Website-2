"use client";

import { useActionState, useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import type { MouseEvent, ReactNode } from "react";
import { useRouter } from "next/navigation";
import { BRAND_SWATCHES } from "@/lib/management/setup";
import { checkSite, type CheckProblem } from "@/lib/websites/checks";
import { dominantColour } from "@/lib/websites/colour";
import type { SiteCopy, SiteSettings } from "@/lib/websites/page-model";
import { renderSitePage } from "@/lib/websites/render";
import { siteBase } from "@/lib/websites/urls";
import { BrandPreview } from "../BrandPreview";
import { ErrorLine, field, labelCls, primaryBtn } from "../ui";
import {
  approveAction,
  generateCopyAction,
  saveAboutAction,
  saveAreasAction,
  saveColourAction,
  saveCompanyAction,
  saveContactAction,
  saveCopyAction,
  uploadImageAction,
  type WebsiteState,
} from "./actions";
import { parseAreas, previewPages, stepPath, type WebsiteStepNo } from "./steps";

const INITIAL: WebsiteState = {};

/**
 * Batch 31, Phase 10: the website setup's steps. One client component so the
 * colour, the copy and the preview share their state:
 *
 *   1 company, logo (uploaded through the existing uploadLogo path) and colour:
 *     the dominant colour is read from the logo in the browser (canvas, then
 *     colour.ts dominantColour) and offered as the colour, and the member can
 *     always override it by hand
 *   2 areas and fee, 3 contact, 4 photo and about (optional)
 *   5 write (first draft free, rewrites counted), preview (renderSitePage in
 *     preview mode: the same components and copy as the public site, the form
 *     sends nothing), edit every copy field (saved as you type), approve
 *
 * Nothing here holds or sends a website id: every action finds the site from
 * who is signed in.
 */

// A server action's body is capped at 1 MB by default, so say so before the upload rather than after it fails.
const MAX_UPLOAD_BYTES = 900_000;

export interface WebsiteSetupProps {
  step: WebsiteStepNo;
  slug: string;
  settings: SiteSettings;
  copy: SiteCopy | null;
  regenUsed: number;
  regenCap: number;
}

export function WebsiteSetup(props: WebsiteSetupProps) {
  switch (props.step) {
    case 1:
      return <CompanyStep settings={props.settings} />;
    case 2:
      return <AreasStep settings={props.settings} />;
    case 3:
      return <ContactStep settings={props.settings} />;
    case 4:
      return <AboutStep settings={props.settings} />;
    case 5:
      return <ReviewStep slug={props.slug} settings={props.settings} copy={props.copy} regenUsed={props.regenUsed} regenCap={props.regenCap} />;
  }
}

// ── Colour from a logo (in the browser) ──

/** The dominant colour of a decoded image, via a small canvas. Null when it has none or the canvas cannot be read. */
function colourOfImage(img: HTMLImageElement): string | null {
  try {
    const longest = Math.max(img.naturalWidth, img.naturalHeight);
    if (!longest) return null;
    const scale = Math.min(1, 128 / longest);
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    return dominantColour(ctx.getImageData(0, 0, w, h).data, w, h);
  } catch {
    // A canvas tainted by another origin throws here: no colour, never an error shown.
    return null;
  }
}

async function colourFromFile(file: File): Promise<string | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return colourOfImage(img);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function colourFromUrl(src: string): Promise<string | null> {
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = src;
    await img.decode();
    return colourOfImage(img);
  } catch {
    return null;
  }
}

// ── Shared pieces ──

const isSwatch = (c: string) => BRAND_SWATCHES.some((s) => s.toUpperCase() === c.toUpperCase());
const validHex = (c: string | null | undefined): c is string => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c);

/** The eight swatches, "Custom" and the picker. `onPick` says the member chose it by hand. */
function ColourPicker({ value, onPick }: { value: string; onPick: (hex: string) => void }) {
  const [custom, setCustom] = useState(!isSwatch(value));
  return (
    <fieldset>
      <legend className={labelCls}>Brand colour</legend>
      <div className="mt-2 flex flex-wrap gap-2">
        {BRAND_SWATCHES.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`Colour ${c}`}
            aria-pressed={!custom && value.toUpperCase() === c.toUpperCase()}
            onClick={() => {
              setCustom(false);
              onPick(c);
            }}
            className={`h-9 w-9 rounded-full border-2 ${!custom && value.toUpperCase() === c.toUpperCase() ? "border-foreground" : "border-transparent"}`}
            style={{ background: c }}
          />
        ))}
        <button type="button" aria-pressed={custom} onClick={() => setCustom(true)} className={`h-9 rounded-full border px-3 text-xs font-medium ${custom ? "border-foreground" : "border-border"}`}>
          Custom
        </button>
      </div>
      {custom ? <input type="color" aria-label="Pick your colour" value={validHex(value) ? value : "#2E3D2B"} onChange={(e) => onPick(e.target.value)} className="mt-3 h-10 w-20 cursor-pointer rounded border border-border bg-background" /> : null}
    </fieldset>
  );
}

/** An image upload (logo or photo): PNG or JPEG, sent as soon as it is chosen, through the owner's own action. */
function ImageUpload({ kind, label, current, onFile }: { kind: "logo" | "photo"; label: string; current: string | null; onFile?: (file: File) => void }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(uploadImageAction, INITIAL);
  const [tooBig, setTooBig] = useState(false);
  useEffect(() => {
    if (state.saved) router.refresh();
  }, [state.saved, router]);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="kind" value={kind} />
      <label className={labelCls} htmlFor={`image-${kind}`}>
        {label}
      </label>
      {current ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={current} alt={kind === "logo" ? "Your logo" : "Your photo"} className={kind === "logo" ? "h-10 max-w-[180px] object-contain" : "h-20 w-20 rounded-full object-cover"} />
      ) : null}
      <input
        id={`image-${kind}`}
        name="image"
        type="file"
        accept="image/png,image/jpeg"
        className="block w-full text-sm"
        onChange={(e) => {
          const input = e.currentTarget;
          const file = input.files?.[0];
          if (!file) return;
          if (file.size > MAX_UPLOAD_BYTES) {
            setTooBig(true);
            input.value = "";
            return;
          }
          setTooBig(false);
          onFile?.(file);
          input.form?.requestSubmit();
        }}
      />
      {pending ? <p className="text-xs text-muted-foreground">Uploading…</p> : null}
      {tooBig ? (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          That file is over 1 MB. Please choose a smaller PNG or JPEG.
        </p>
      ) : null}
      <ErrorLine state={state} />
    </form>
  );
}

/** Moves on once a step's save has gone through. */
function useAdvance(state: WebsiteState, to: string) {
  const router = useRouter();
  useEffect(() => {
    if (state.saved) router.push(to);
  }, [state.saved, to, router]);
}

// ── Step 1: company, logo, colour ──

function CompanyStep({ settings }: { settings: SiteSettings }) {
  const [name, setName] = useState(settings.companyName);
  const [primary, setPrimary] = useState<string>(settings.brandColour ?? BRAND_SWATCHES[0]);
  const [logoColour, setLogoColour] = useState<string | null>(null);
  const picked = useRef(false);
  const [state, action, pending] = useActionState(saveCompanyAction, INITIAL);
  useAdvance(state, stepPath(2));

  // The colour of a freshly chosen logo becomes the colour, unless the member has already picked one by hand.
  async function onLogoFile(file: File) {
    const c = await colourFromFile(file);
    if (!c) return;
    setLogoColour(c);
    if (!picked.current) setPrimary(c);
  }

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="space-y-5">
        <ImageUpload kind="logo" label="Logo (PNG or JPEG, under 1 MB)" current={settings.logoUrl} onFile={onLogoFile} />
        <form action={action} className="space-y-5">
          <div>
            <label className={labelCls} htmlFor="companyName">
              Company name
            </label>
            <input id="companyName" name="companyName" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} className={field} autoComplete="organization" />
          </div>
          <ColourPicker
            value={primary}
            onPick={(hex) => {
              picked.current = true;
              setPrimary(hex);
            }}
          />
          {logoColour && logoColour.toLowerCase() !== primary.toLowerCase() ? (
            <button
              type="button"
              onClick={() => {
                picked.current = false;
                setPrimary(logoColour);
              }}
              className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
            >
              <span aria-hidden className="h-4 w-4 rounded-full border border-border" style={{ background: logoColour }} />
              Use the colour from my logo
            </button>
          ) : logoColour ? (
            <p className="text-xs text-muted-foreground">Colour taken from your logo. Change it above if you like.</p>
          ) : null}
          <input type="hidden" name="brandColour" value={primary} />
          <ErrorLine state={state} />
          <button type="submit" disabled={pending || !name.trim()} className={primaryBtn}>
            {pending ? "Saving…" : "Continue"}
          </button>
        </form>
      </div>
      <BrandPreview companyName={name} logoUrl={settings.logoUrl} primary={primary} />
    </div>
  );
}

// ── Step 2: areas and fee ──

function AreasStep({ settings }: { settings: SiteSettings }) {
  const [areas, setAreas] = useState(settings.areas.join("\n"));
  const [state, action, pending] = useActionState(saveAreasAction, INITIAL);
  useAdvance(state, stepPath(3));
  const parsed = parseAreas(areas);
  return (
    <form action={action} className="space-y-5">
      <div>
        <label className={labelCls} htmlFor="areas">
          Areas you cover (one per line)
        </label>
        <textarea id="areas" name="areas" rows={5} required value={areas} onChange={(e) => setAreas(e.target.value)} className={field} placeholder={"Leeds\nHarrogate"} />
        <p className="mt-1 text-xs text-muted-foreground">
          {parsed.length === 0 ? "Each area gets its own page." : `${parsed.length} area page${parsed.length === 1 ? "" : "s"}: ${parsed.slice(0, 6).join(", ")}${parsed.length > 6 ? ", …" : ""}`}
        </p>
      </div>
      <div>
        <label className={labelCls} htmlFor="fee">
          Management fee (%)
        </label>
        <input id="fee" name="fee" required inputMode="decimal" defaultValue={settings.managementFeePct ?? ""} className={`${field} max-w-[8rem]`} placeholder="15" />
        <p className="mt-1 text-xs text-muted-foreground">Shown on your fees page exactly as you enter it.</p>
      </div>
      <ErrorLine state={state} />
      <button type="submit" disabled={pending} className={primaryBtn}>
        {pending ? "Saving…" : "Continue"}
      </button>
    </form>
  );
}

// ── Step 3: contact ──

function ContactStep({ settings }: { settings: SiteSettings }) {
  const [state, action, pending] = useActionState(saveContactAction, INITIAL);
  useAdvance(state, stepPath(4));
  return (
    <form action={action} className="space-y-5">
      <div>
        <label className={labelCls} htmlFor="email">
          Contact email
        </label>
        <input id="email" name="email" type="email" required maxLength={254} defaultValue={settings.contactEmail} className={field} autoComplete="email" />
      </div>
      <div>
        <label className={labelCls} htmlFor="phone">
          Contact phone (UK)
        </label>
        <input id="phone" name="phone" type="tel" required maxLength={40} defaultValue={settings.contactPhone} className={field} autoComplete="tel" />
      </div>
      <ErrorLine state={state} />
      <button type="submit" disabled={pending} className={primaryBtn}>
        {pending ? "Saving…" : "Continue"}
      </button>
    </form>
  );
}

// ── Step 4: photo and about (optional) ──

function AboutStep({ settings }: { settings: SiteSettings }) {
  const [state, action, pending] = useActionState(saveAboutAction, INITIAL);
  useAdvance(state, stepPath(5));
  return (
    <div className="space-y-6">
      <ImageUpload kind="photo" label="A photo of you or your team (PNG or JPEG, under 1 MB)" current={settings.photoUrl} />
      <form action={action} className="space-y-5">
        <div>
          <label className={labelCls} htmlFor="aboutText">
            A few words about you
          </label>
          <textarea id="aboutText" name="aboutText" rows={6} maxLength={2000} defaultValue={settings.aboutText ?? ""} className={field} placeholder="How long you have been managing property, where you are based, what you care about." />
          <p className="mt-1 text-xs text-muted-foreground">Shown on your About page as written. Leave it empty to use our draft only.</p>
        </div>
        <ErrorLine state={state} />
        <div className="flex flex-col gap-3 sm:flex-row">
          <button type="submit" disabled={pending} className={primaryBtn}>
            {pending ? "Saving…" : "Continue"}
          </button>
          <button type="submit" name="skip" value="1" formNoValidate disabled={pending} className="min-h-12 w-full rounded-lg border border-border px-4 text-sm font-medium hover:bg-muted disabled:opacity-50">
            Skip this step
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Step 5: write, preview, edit, approve ──

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

const problemLine = (p: CheckProblem) => `${p.page === "site" ? "Your details" : `The ${p.page === "home" ? "home" : p.page.replace(/^areas\//, "")} page`}: ${p.message}`;

function Section({ title, children, open }: { title: string; children: ReactNode; open?: boolean }) {
  return (
    <details open={open} className="rounded-lg border border-border">
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-foreground">{title}</summary>
      <div className="space-y-4 border-t border-border px-4 py-4">{children}</div>
    </details>
  );
}

function Text({ label, value, onChange, rows, max }: { label: string; value: string; onChange: (v: string) => void; rows?: number; max?: number }) {
  const id = useId();
  return (
    <div>
      <label className="block text-xs font-medium text-muted-foreground" htmlFor={id}>
        {label}
      </label>
      {rows ? <textarea id={id} rows={rows} maxLength={max} value={value} onChange={(e) => onChange(e.target.value)} className={field} /> : <input id={id} maxLength={max} value={value} onChange={(e) => onChange(e.target.value)} className={field} />}
    </div>
  );
}

function ReviewStep({ slug, settings, copy: initialCopy, regenUsed, regenCap }: { slug: string; settings: SiteSettings; copy: SiteCopy | null; regenUsed: number; regenCap: number }) {
  const router = useRouter();
  const [copy, setCopy] = useState<SiteCopy | null>(initialCopy);
  const [colour, setColour] = useState<string>(settings.brandColour ?? BRAND_SWATCHES[0]);
  const [regenLeft, setRegenLeft] = useState(Math.max(0, regenCap - regenUsed));
  const [path, setPath] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [genError, setGenError] = useState<string | null>(null);
  const [colourNote, setColourNote] = useState<string | null>(null);
  const [result, setResult] = useState<{ error?: string; problems?: string[] } | null>(null);
  const [generating, startGenerate] = useTransition();
  const [approving, startApprove] = useTransition();

  // The latest copy and what is waiting to be saved. Edits are saved a moment after the last keystroke.
  const latest = useRef<SiteCopy | null>(initialCopy);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef<Promise<unknown> | null>(null);
  const colourPending = useRef<string | null>(null);
  const colourTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function persist() {
    timer.current = null;
    const c = latest.current;
    if (!c) return;
    setSaveState("saving");
    const run = saveCopyAction(JSON.stringify(c));
    inflight.current = run;
    const r = await run;
    if (latest.current === c) {
      dirty.current = !r.saved;
      setSaveState(r.saved ? "saved" : "error");
    }
  }

  function edit(fn: (c: SiteCopy) => SiteCopy) {
    if (!latest.current) return;
    const next = fn(latest.current);
    latest.current = next;
    dirty.current = true;
    setCopy(next);
    setSaveState("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void persist(), 1200);
  }

  async function saveColourNow() {
    if (colourTimer.current) clearTimeout(colourTimer.current);
    colourTimer.current = null;
    const hex = colourPending.current;
    colourPending.current = null;
    if (hex) await saveColourAction(hex);
  }

  function pickColour(hex: string, now = false) {
    setColour(hex);
    setColourNote(null);
    colourPending.current = hex;
    if (colourTimer.current) clearTimeout(colourTimer.current);
    colourTimer.current = now ? null : setTimeout(() => void saveColourNow(), 600);
    if (now) void saveColourNow();
  }

  /** Everything typed is saved before Approve reads the site. */
  async function flush(): Promise<boolean> {
    if (timer.current) {
      clearTimeout(timer.current);
      await persist();
    } else if (inflight.current) {
      await inflight.current;
    }
    await saveColourNow();
    return !dirty.current;
  }

  const pages = useMemo(() => previewPages({ slug }, settings, copy, { brandColour: colour }), [slug, settings, copy, colour]);
  const check = useMemo(() => (pages ? checkSite(pages, { managementFeePct: settings.managementFeePct, brandColour: colour, logoUrl: settings.logoUrl }) : null), [pages, settings, colour]);
  const node = pages ? (renderSitePage(pages, path, { preview: true }) ?? renderSitePage(pages, "", { preview: true })) : null;

  /** In the preview a link switches the preview's page: it never leaves the setup (the site is not live yet). */
  function onPreviewClick(e: MouseEvent<HTMLDivElement>) {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#") || /^(mailto|tel):/i.test(href)) return;
    e.preventDefault();
    const base = siteBase({ slug });
    if (href === base || href.startsWith(`${base}/`)) {
      const rest = href.slice(base.length).replace(/^\/+/, "").split(/[?#]/)[0];
      if (pages?.some((p) => p.path === rest)) setPath(rest);
    }
  }

  function write() {
    if (copy && !window.confirm("Rewriting replaces all of your copy, including any changes you made. Go ahead?")) return;
    startGenerate(async () => {
      setGenError(null);
      setResult(null);
      const r = await generateCopyAction();
      if (r.copy) {
        latest.current = r.copy;
        dirty.current = false;
        setCopy(r.copy);
        setPath("");
        setSaveState("saved");
      }
      if (r.regenLeft !== undefined) setRegenLeft(r.regenLeft);
      if (r.error) setGenError(r.error);
      else router.refresh();
    });
  }

  function approve() {
    startApprove(async () => {
      setResult(null);
      if (!(await flush())) {
        setResult({ error: "Your latest changes could not be saved. Please try again.", problems: [] });
        return;
      }
      const r = await approveAction();
      if (r.live) router.refresh();
      else setResult({ error: r.error, problems: r.problems });
    });
  }

  async function colourFromLogo() {
    setColourNote(null);
    const c = settings.logoUrl ? await colourFromUrl(settings.logoUrl) : null;
    if (c) pickColour(c, true);
    else setColourNote("We could not read a colour from your logo. Pick one above instead.");
  }

  if (!copy || !pages) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">We will write every page of your website from what you have told us: a home page, a page for each area, fees, about and questions. It takes about a minute. The first draft is free and you can change every word.</p>
        {genError ? (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {genError}
          </p>
        ) : null}
        <button type="button" onClick={write} disabled={generating} className={primaryBtn}>
          {generating ? "Writing your website… this takes about a minute" : "Write my website"}
        </button>
      </div>
    );
  }

  const options = pages.map((p) => ({ value: p.path, label: p.key === "area" ? `Area: ${p.area?.name ?? ""}` : p.key === "home" ? "Home" : p.key[0].toUpperCase() + p.key.slice(1) }));
  const problems = check?.problems ?? [];
  const status = saveState === "saving" ? "Saving…" : saveState === "dirty" ? "Unsaved changes" : saveState === "saved" ? "All changes saved" : saveState === "error" ? "Could not save your changes. Keep typing to try again." : "";

  return (
    <div className="space-y-8">
      <section aria-labelledby="preview-h" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="preview-h" className="text-lg font-semibold text-foreground">
            Preview
          </h2>
          <div>
            <label className="block text-xs font-medium text-muted-foreground" htmlFor="preview-page">
              Page
            </label>
            <select id="preview-page" value={path} onChange={(e) => setPath(e.target.value)} className="mt-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm">
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div onClickCapture={onPreviewClick} aria-label="Preview of your website" className="max-h-[75vh] overflow-auto rounded-xl border border-border">
          {node}
        </div>
        <p className="text-xs text-muted-foreground">Your website will be at {siteBase({ slug })}. Links in the preview move around the preview; the form sends nothing.</p>
      </section>

      <section aria-labelledby="colour-h" className="space-y-3">
        <h2 id="colour-h" className="text-lg font-semibold text-foreground">
          Colour
        </h2>
        <ColourPicker value={colour} onPick={(hex) => pickColour(hex)} />
        {settings.logoUrl ? (
          <button type="button" onClick={() => void colourFromLogo()} className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted">
            Use the colour from my logo
          </button>
        ) : null}
        {colourNote ? <p className="text-xs text-muted-foreground">{colourNote}</p> : null}
      </section>

      <section aria-labelledby="copy-h" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="copy-h" className="text-lg font-semibold text-foreground">
            Your words
          </h2>
          <p role="status" className="text-xs text-muted-foreground">
            {status}
          </p>
        </div>
        <Section title="Home page" open>
          <Text label="Headline" value={copy.home.headline} max={200} onChange={(v) => edit((c) => ({ ...c, home: { ...c.home, headline: v } }))} />
          <Text label="Line under the headline" value={copy.home.subheadline} max={300} onChange={(v) => edit((c) => ({ ...c, home: { ...c.home, subheadline: v } }))} />
          <Text label="Introduction" rows={4} max={3000} value={copy.home.intro} onChange={(v) => edit((c) => ({ ...c, home: { ...c.home, intro: v } }))} />
          {copy.home.benefits.map((b, i) => (
            <div key={i} className="space-y-2 rounded-md bg-muted/40 p-3">
              <Text label={`Point ${i + 1} title`} value={b.title} max={120} onChange={(v) => edit((c) => ({ ...c, home: { ...c.home, benefits: c.home.benefits.map((x, j) => (j === i ? { ...x, title: v } : x)) } }))} />
              <Text label={`Point ${i + 1} text`} rows={3} max={3000} value={b.body} onChange={(v) => edit((c) => ({ ...c, home: { ...c.home, benefits: c.home.benefits.map((x, j) => (j === i ? { ...x, body: v } : x)) } }))} />
            </div>
          ))}
        </Section>
        {copy.areas.map((a, i) => (
          <Section key={a.area} title={`Area page: ${a.area}`}>
            <Text label="Headline" value={a.headline} max={200} onChange={(v) => edit((c) => ({ ...c, areas: c.areas.map((x, j) => (j === i ? { ...x, headline: v } : x)) }))} />
            <Text label="Text" rows={5} max={3000} value={a.body} onChange={(v) => edit((c) => ({ ...c, areas: c.areas.map((x, j) => (j === i ? { ...x, body: v } : x)) }))} />
          </Section>
        ))}
        <Section title="Fees page">
          <p className="text-xs text-muted-foreground">Your fee ({settings.managementFeePct ?? "not set"}%) comes from step 2 and is added for you.</p>
          <Text label="Headline" value={copy.fees.headline} max={200} onChange={(v) => edit((c) => ({ ...c, fees: { ...c.fees, headline: v } }))} />
          <Text label="Text" rows={4} max={3000} value={copy.fees.body} onChange={(v) => edit((c) => ({ ...c, fees: { ...c.fees, body: v } }))} />
          <Text label="What is included (one per line)" rows={5} max={2400} value={copy.fees.includes.join("\n")} onChange={(v) => edit((c) => ({ ...c, fees: { ...c.fees, includes: v.split("\n") } }))} />
        </Section>
        <Section title="About page">
          <Text label="Headline" value={copy.about.headline} max={200} onChange={(v) => edit((c) => ({ ...c, about: { ...c.about, headline: v } }))} />
          <Text label="Text" rows={5} max={3000} value={copy.about.body} onChange={(v) => edit((c) => ({ ...c, about: { ...c.about, body: v } }))} />
        </Section>
        <Section title="Questions page">
          <Text label="Headline" value={copy.faq.headline} max={200} onChange={(v) => edit((c) => ({ ...c, faq: { ...c.faq, headline: v } }))} />
          {copy.faq.items.map((q, i) => (
            <div key={i} className="space-y-2 rounded-md bg-muted/40 p-3">
              <Text label={`Question ${i + 1}`} value={q.question} max={300} onChange={(v) => edit((c) => ({ ...c, faq: { ...c.faq, items: c.faq.items.map((x, j) => (j === i ? { ...x, question: v } : x)) } }))} />
              <Text label="Answer" rows={3} max={2000} value={q.answer} onChange={(v) => edit((c) => ({ ...c, faq: { ...c.faq, items: c.faq.items.map((x, j) => (j === i ? { ...x, answer: v } : x)) } }))} />
            </div>
          ))}
        </Section>
      </section>

      <section aria-labelledby="rewrite-h" className="space-y-2">
        <h2 id="rewrite-h" className="text-lg font-semibold text-foreground">
          Not happy with it?
        </h2>
        <p className="text-sm text-muted-foreground">
          We can write it again. This replaces all of your words, including changes you made. Rewrites left: <strong>{regenLeft}</strong> of {regenCap}.
        </p>
        {genError ? (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {genError}
          </p>
        ) : null}
        <button type="button" onClick={write} disabled={generating || approving || regenLeft === 0} className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50">
          {generating ? "Writing… about a minute" : "Write it again"}
        </button>
      </section>

      <section aria-labelledby="approve-h" className="space-y-3">
        <h2 id="approve-h" className="text-lg font-semibold text-foreground">
          Approve
        </h2>
        {problems.length > 0 ? (
          <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <p className="font-medium">Fix {problems.length === 1 ? "this" : "these"} before you approve:</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {problems.slice(0, 12).map((p, i) => (
                <li key={i}>{problemLine(p)}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Approving puts your website live at {siteBase({ slug })}. We check every page first, and put it back in preview if anything is wrong.</p>
        )}
        {result ? (
          <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {result.error ? <p className="font-medium">{result.error}</p> : null}
            {result.problems?.length ? (
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {result.problems.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        <button type="button" onClick={approve} disabled={approving || generating || problems.length > 0} className={primaryBtn}>
          {approving ? "Checking every page…" : "Approve and go live"}
        </button>
      </section>
    </div>
  );
}
