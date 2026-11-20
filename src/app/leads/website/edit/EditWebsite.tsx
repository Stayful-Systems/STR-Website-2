"use client";

import { useActionState, useEffect, useMemo, useState, useTransition } from "react";
import type { MouseEvent, ReactNode } from "react";
import { useRouter } from "next/navigation";
import { applyPageFields, pageFieldsOf, pageLabel } from "@/lib/websites/edit-fields";
import { parsePageRefKey, type PageRef } from "@/lib/websites/edit-rules";
import type { SiteCopy, SiteSettings } from "@/lib/websites/page-model";
import { renderSitePage, sitePagesOf } from "@/lib/websites/render";
import { siteBase } from "@/lib/websites/urls";
import { ErrorLine, field, labelCls, primaryBtn } from "../../setup/ui";
import { alignCopy, parseAreas } from "../../setup/website/steps";
import {
  approvePageAction,
  discardAction,
  publishAction,
  restoreAction,
  rewritePendingAction,
  savePagesAction,
  saveChangesAction,
  uploadImageAction,
  type EditState,
} from "./edit-actions";

const INITIAL: EditState = {};

// A server action's body is capped at 1 MB by default, so say so before the upload rather than after it fails.
const MAX_UPLOAD_BYTES = 900_000;

export interface EditVersion {
  versionNo: number;
  kind: "approved" | "publish" | "restore";
  restoredFrom: number | null;
  publishedAt: string;
}

export interface EditWebsiteProps {
  slug: string;
  domain: string | null;
  /** The draft's settings, or the live site's when there is no draft yet. */
  settings: SiteSettings;
  copy: SiteCopy;
  hasDraft: boolean;
  pending: { toWrite: string[]; toApprove: string[] };
  /** Page rewrites left this month. */
  left: number;
  /** The checks over the draft, one plain sentence each. */
  problems: string[];
  versions: EditVersion[];
  newestVersion: number;
}

/**
 * Batch 36 (Phase 4): the edit screen, one client component so the fields, the
 * pages to approve and the preview share their state.
 *
 *   fields      the setup's own (company, colour, areas, fee, contact, about),
 *               saved to the DRAFT; the preview moves as they are typed
 *   images      a new logo or photo goes into the draft
 *   pages       pages that need writing again are written on request (one of
 *               the month's rewrites); each written page is read, edited if
 *               wanted, and approved before Publish
 *   publish     the same checks as going live; problems are listed
 *   history     the recent versions, with a one-tap Restore
 *
 * Nothing here holds or sends a website, user, funnel or version id: every
 * action finds the site from who is signed in, and Restore sends a version
 * NUMBER that the server looks up among this owner's own versions.
 */
export function EditWebsite(props: EditWebsiteProps) {
  const router = useRouter();
  const { settings, copy } = props;
  const [live, setLive] = useState({
    companyName: settings.companyName,
    brandColour: settings.brandColour ?? "",
    areas: settings.areas.join("\n"),
    fee: settings.managementFeePct === null ? "" : String(settings.managementFeePct),
    email: settings.contactEmail,
    phone: settings.contactPhone,
    aboutText: settings.aboutText ?? "",
  });
  const set = (k: keyof typeof live) => (e: { currentTarget: { value: string } }) => setLive((s) => ({ ...s, [k]: e.currentTarget.value }));

  // What the preview draws: the saved draft with what is being typed on top.
  const previewSettings = useMemo<SiteSettings>(() => {
    const fee = Number(live.fee.replace(/%/g, "").trim());
    return {
      ...settings,
      companyName: live.companyName.trim(),
      brandColour: /^#[0-9a-fA-F]{6}$/.test(live.brandColour.trim()) ? live.brandColour.trim() : settings.brandColour,
      areas: parseAreas(live.areas),
      managementFeePct: Number.isFinite(fee) && fee > 0 && fee <= 100 ? fee : settings.managementFeePct,
      contactEmail: live.email.trim(),
      contactPhone: live.phone.trim(),
      aboutText: live.aboutText.trim() || null,
    };
  }, [settings, live]);
  const site = useMemo(() => ({ slug: props.slug, domain: props.domain }), [props.slug, props.domain]);
  const pages = useMemo(() => sitePagesOf(site, previewSettings, alignCopy(previewSettings.areas, copy)), [site, previewSettings, copy]);
  const [path, setPath] = useState("");
  const node = pages ? (renderSitePage(pages, path, { preview: true }) ?? renderSitePage(pages, "", { preview: true })) : null;

  /** In the preview a link switches the preview's page: it never leaves the editor. */
  function onPreviewClick(e: MouseEvent<HTMLDivElement>) {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#") || /^(mailto|tel):/i.test(href)) return;
    e.preventDefault();
    const base = siteBase(site);
    if (href === base || href.startsWith(`${base}/`)) {
      const rest = href.slice(base.length).replace(/^\/+/, "").split(/[?#]/)[0];
      if (pages?.some((p) => p.path === rest)) setPath(rest);
    }
  }

  const [saveState, saveAction, saving] = useActionState(saveChangesAction, INITIAL);
  useEffect(() => {
    if (saveState.ok) router.refresh();
  }, [saveState, router]);

  const [result, setResult] = useState<EditState | null>(null);
  const [working, start] = useTransition();
  const run = (fn: () => Promise<EditState>) =>
    start(async () => {
      setResult(null);
      const r = await fn();
      setResult(r);
      if (r.ok) router.refresh();
    });

  const nothingPending = props.pending.toWrite.length === 0 && props.pending.toApprove.length === 0;
  const canPublish = props.hasDraft && nothingPending && props.problems.length === 0;
  const areaNameOf = (ref: PageRef) => settings.areas.find((a) => a.toLowerCase() === (ref.area ?? "").toLowerCase());

  return (
    <div className="space-y-8">
      {/* ── The fields ── */}
      <form key={JSON.stringify(settings)} action={saveAction} className="space-y-5">
        <h2 className="text-lg font-semibold text-foreground">Your details</h2>
        <div>
          <label className={labelCls} htmlFor="companyName">Company name</label>
          <input id="companyName" name="companyName" required value={live.companyName} onChange={set("companyName")} className={field} />
        </div>
        <div>
          <label className={labelCls} htmlFor="brandColour">Brand colour (six-digit hex, like #1a73e8)</label>
          <input id="brandColour" name="brandColour" value={live.brandColour} onChange={set("brandColour")} className={`${field} max-w-[10rem]`} placeholder="#1a73e8" />
        </div>
        <div>
          <label className={labelCls} htmlFor="areas">Areas you cover (one per line)</label>
          <textarea id="areas" name="areas" rows={5} required value={live.areas} onChange={set("areas")} className={field} />
          <p className="mt-1 text-xs text-muted-foreground">A new area gets its own page, which needs writing before you can publish. A removed area&rsquo;s page is dropped.</p>
        </div>
        <div>
          <label className={labelCls} htmlFor="fee">Management fee (%)</label>
          <input id="fee" name="fee" required inputMode="decimal" value={live.fee} onChange={set("fee")} className={`${field} max-w-[8rem]`} />
          <p className="mt-1 text-xs text-muted-foreground">Shown on your fees page exactly as you enter it. Changing it rewrites no pages.</p>
        </div>
        <div>
          <label className={labelCls} htmlFor="email">Contact email</label>
          <input id="email" name="email" type="email" required value={live.email} onChange={set("email")} className={field} />
        </div>
        <div>
          <label className={labelCls} htmlFor="phone">Contact phone (UK)</label>
          <input id="phone" name="phone" type="tel" required value={live.phone} onChange={set("phone")} className={field} />
        </div>
        <div>
          <label className={labelCls} htmlFor="aboutText">About you (optional)</label>
          <textarea id="aboutText" name="aboutText" rows={4} value={live.aboutText} onChange={set("aboutText")} className={field} />
          <p className="mt-1 text-xs text-muted-foreground">Changing this means your About page is written again.</p>
        </div>
        <ErrorLine state={saveState} />
        {saveState.ok ? <p role="status" className="text-sm text-foreground">{saveState.message}</p> : null}
        <button type="submit" disabled={saving} className={primaryBtn}>{saving ? "Saving…" : "Save changes to my draft"}</button>
      </form>

      {/* ── Logo and photo ── */}
      <section className="space-y-5">
        <h2 className="text-lg font-semibold text-foreground">Logo and photo</h2>
        <ImageUpload kind="logo" label="Logo (PNG or JPEG)" current={settings.logoUrl} />
        <ImageUpload kind="photo" label="Photo of you or your team (optional)" current={settings.photoUrl} />
      </section>

      {/* ── Pages to write and approve ── */}
      {!nothingPending ? (
        <section className="space-y-4 rounded-lg border border-border p-4">
          <h2 className="text-lg font-semibold text-foreground">Pages to check</h2>
          {props.pending.toWrite.length > 0 ? (
            <div className="space-y-2">
              <p className="text-sm text-foreground">These pages need writing again: {props.pending.toWrite.map((k) => labelOfKey(k, areaNameOf)).join(", ")}.</p>
              <p className="text-xs text-muted-foreground">Writing uses one of your page rewrites for the month. You have {props.left} left. You can also write a page yourself below instead.</p>
              <button type="button" disabled={working || props.left === 0} className={primaryBtn} onClick={() => run(() => rewritePendingAction())}>
                {working ? "Writing…" : "Write these pages"}
              </button>
              {props.left === 0 ? <p className="text-xs text-muted-foreground">You have used this month&rsquo;s rewrites. They start again next month, or you can write the pages yourself.</p> : null}
            </div>
          ) : null}
          {[...props.pending.toWrite, ...props.pending.toApprove].map((k) => {
            const ref = parsePageRefKey(k);
            if (!ref) return null;
            return <PageCard key={k} pageKey={k} ref_={ref} copy={copy} written={props.pending.toApprove.includes(k)} label={labelOfKey(k, areaNameOf)} onDone={() => router.refresh()} />;
          })}
        </section>
      ) : null}

      {/* ── Preview ── */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">Preview</h2>
        {pages ? (
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Pages">
            {pages.map((p) => (
              <button key={p.path || "home"} type="button" onClick={() => setPath(p.path)} className={`rounded-md border px-2.5 py-1 text-xs ${p.path === path ? "border-primary bg-primary/10 font-medium" : "border-border"}`}>
                {p.path === "" ? "Home" : p.area ? p.area.name : p.key}
              </button>
            ))}
          </div>
        ) : null}
        <div onClick={onPreviewClick} className="max-h-[70vh] overflow-auto rounded-lg border border-border bg-white">{node}</div>
      </section>

      {/* ── Publish ── */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">Publish</h2>
        {!props.hasDraft ? <p className="text-sm text-muted-foreground">Make a change above and it will appear here, ready to publish.</p> : null}
        {props.hasDraft && props.problems.length > 0 ? (
          <div role="alert" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-foreground">
            <p className="font-medium">Fix these before you publish:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">{props.problems.map((p) => <li key={p}>{p}</li>)}</ul>
          </div>
        ) : null}
        {props.hasDraft && !nothingPending ? <p className="text-sm text-muted-foreground">Write and approve the pages above first.</p> : null}
        <button type="button" disabled={working || !canPublish} className={primaryBtn} onClick={() => run(() => publishAction())}>
          {working ? "Publishing…" : "Publish my changes"}
        </button>
        {props.hasDraft ? (
          <button
            type="button"
            disabled={working}
            className="text-sm font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
            onClick={() => {
              if (window.confirm("Throw away your draft? Your live website is not affected.")) run(() => discardAction());
            }}
          >
            Discard my draft
          </button>
        ) : null}
        <ResultLine r={result} />
      </section>

      {/* ── History ── */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">Earlier versions</h2>
        {props.versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">Your first change will save the site as it is now, so you can always come back to it.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {props.versions.map((v) => (
              <li key={v.versionNo} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="text-foreground">
                  {versionLabel(v)} <span className="text-xs text-muted-foreground">· {dateText(v.publishedAt)}</span>
                  {v.versionNo === props.newestVersion ? <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">Live now</span> : null}
                </span>
                {v.versionNo === props.newestVersion ? null : (
                  <button
                    type="button"
                    disabled={working}
                    className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                    onClick={() => {
                      if (window.confirm("Put this version live again? It is checked first, and your current site is kept in the list.")) run(() => restoreAction(v.versionNo));
                    }}
                  >
                    Restore
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ── Pieces ──

function labelOfKey(key: string, areaNameOf: (r: PageRef) => string | undefined): string {
  const ref = parsePageRefKey(key);
  if (!ref) return key;
  return `the ${pageLabel(ref, areaNameOf(ref))} page`;
}

function versionLabel(v: EditVersion): string {
  if (v.kind === "approved") return `Version ${v.versionNo}: your site as first approved`;
  if (v.kind === "restore") return `Version ${v.versionNo}: version ${v.restoredFrom ?? "?"} put back`;
  return `Version ${v.versionNo}`;
}

function dateText(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" });
}

function ResultLine({ r }: { r: EditState | null }): ReactNode {
  if (!r) return null;
  if (r.error) {
    return (
      <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        <p>{r.error}</p>
        {r.problems && r.problems.length > 0 ? <ul className="mt-1 list-disc space-y-0.5 pl-5">{r.problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
      </div>
    );
  }
  return r.message ? <p role="status" className="text-sm text-foreground">{r.message}</p> : null;
}

/** One page to write or approve: its fields, the operator's own edits, and Approve (which saves any edits first). */
function PageCard({ pageKey, ref_, copy, written, label, onDone }: { pageKey: string; ref_: PageRef; copy: SiteCopy; written: boolean; label: string; onDone: () => void }) {
  const fields = pageFieldsOf(copy, ref_);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.name, f.value])));
  const [msg, setMsg] = useState<EditState | null>(null);
  const [busy, start] = useTransition();
  const changed = fields.some((f) => values[f.name] !== f.value);

  const save = async (): Promise<EditState> => savePagesAction(JSON.stringify(applyPageFields(copy, ref_, values)));

  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-sm font-medium text-foreground">
        {label.charAt(0).toUpperCase() + label.slice(1)} <span className="text-xs font-normal text-muted-foreground">{written ? "· written, waiting for your approval" : "· not written yet"}</span>
      </p>
      <div className="mt-3 space-y-3">
        {fields.map((f) => (
          <div key={f.name}>
            <label className="block text-xs font-medium text-foreground" htmlFor={`${pageKey}-${f.name}`}>{f.label}</label>
            {f.multiline ? (
              <textarea id={`${pageKey}-${f.name}`} rows={4} value={values[f.name] ?? ""} onChange={(e) => setValues((s) => ({ ...s, [f.name]: e.target.value }))} className={field} />
            ) : (
              <input id={`${pageKey}-${f.name}`} value={values[f.name] ?? ""} onChange={(e) => setValues((s) => ({ ...s, [f.name]: e.target.value }))} className={field} />
            )}
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || !changed}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
          onClick={() =>
            start(async () => {
              const r = await save();
              setMsg(r);
              if (r.ok) onDone();
            })
          }
        >
          Save my changes
        </button>
        {written || changed ? (
          <button
            type="button"
            disabled={busy}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
            onClick={() =>
              start(async () => {
                // Anything typed is saved first, so what is approved is what is on screen.
                if (changed) {
                  const s = await save();
                  if (!s.ok) {
                    setMsg(s);
                    return;
                  }
                }
                const r = await approvePageAction(pageKey);
                setMsg(r);
                if (r.ok) onDone();
              })
            }
          >
            Approve this page
          </button>
        ) : null}
      </div>
      <ResultLine r={msg} />
    </div>
  );
}

/** An image upload (logo or photo): PNG or JPEG, sent as soon as it is chosen, into the draft. */
function ImageUpload({ kind, label, current }: { kind: "logo" | "photo"; label: string; current: string | null }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(uploadImageAction, INITIAL);
  const [tooBig, setTooBig] = useState(false);
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, router]);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="kind" value={kind} />
      <label className={labelCls} htmlFor={`image-${kind}`}>{label}</label>
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
          input.form?.requestSubmit();
        }}
      />
      {pending ? <p className="text-xs text-muted-foreground">Uploading…</p> : null}
      {tooBig ? <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">That file is over 1 MB. Please choose a smaller PNG or JPEG.</p> : null}
      <ErrorLine state={state} />
      {state.ok ? <p role="status" className="text-xs text-muted-foreground">Saved to your draft.</p> : null}
    </form>
  );
}
