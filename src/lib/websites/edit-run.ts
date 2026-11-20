/**
 * Batch 36: editing a LIVE customer website, as an orchestration with every
 * effect injected (the database, the copy writer, the file store, the page
 * fetch, activity), so the whole flow runs under node --test with fakes. The
 * real wiring is edit-server.ts; the screen's server actions call that.
 *
 * The shape of an edit:
 *
 *   openDraft            version 1 = the approved site (once), then the live
 *                        settings and copy are copied into website_drafts with
 *                        base_version = the newest version number
 *   saveDraftFields      a patch to the draft ONLY (the live site never moves):
 *                        alignCopy, then the pages the change makes stale are
 *                        marked pending. A new area's block starts empty so the
 *                        checks block Publish until it is written.
 *   rewritePending       takes ONE of the owner's 10 monthly rewrites (atomic,
 *                        given back on failure) and writes only the pending pages
 *   approvePage /
 *   editPage             a rewritten page is approved, or edited by hand first
 *   uploadDraftImage     a new logo or photo goes in the draft; a file is never
 *                        deleted just because it was replaced
 *   publish              refuses while pages are pending; runs the SAME goLive
 *                        Approve uses (checks, then every public page fetched),
 *                        with markLive = the version publish and rollback = put
 *                        the previous version back. Only on success is the
 *                        activity recorded and the files nothing refers to
 *                        any more deleted.
 *   restore              an old version is published as a NEW version through
 *                        the same path (so the same checks)
 *   discardDraft         the draft goes; files only it used go too
 *
 * Pending pages are kept in website_drafts.pending_pages with a one-letter
 * prefix: "w:<page>" is still to be written, "a:<page>" is written and awaiting
 * the operator's approval. A page key is "home", "fees", "about", "faq" or
 * "area:<lowercase name>" (edit-rules pageRefKey).
 *
 * Pure: imports no server-only module and reads no environment.
 */
import { alignCopy, sanitiseCopy } from '../../app/leads/setup/website/steps.ts';
import { checkSite, type CheckProblem } from './checks.ts';
import type { CopyPage } from './copy-prompt.ts';
import {
  WEBSITE_EDIT_REWRITES_PER_MONTH,
  copyTextOf,
  filesInUse,
  filesToDelete,
  pageRefKey,
  pagesToRewrite,
  parsePageRefKey,
  rewritesLeft,
  takeRewrite,
  type PageRef,
  type RewritePlan,
} from './edit-rules.ts';
import { goLive, goLiveMessages, type PageFetch } from './golive-server.ts';
import { buildSitePages, type SiteCopy, type SiteSettings } from './page-model.ts';
import type { SiteRef, WebsiteStatus } from './types.ts';

// ── Shapes ──

/** The owner's site as the run reads it (fresh each call). */
export interface EditSite extends SiteRef {
  id: string;
  status: WebsiteStatus;
  settings: SiteSettings;
  pages: SiteCopy | null;
  /** paused AND website_grace.switched_off_at set: switched off, not just paused. */
  switchedOff: boolean;
}

export interface EditDraft {
  settings: SiteSettings;
  pages: SiteCopy;
  baseVersion: number | null;
  /** "w:<page>" still to write, "a:<page>" written and awaiting approval. */
  pendingPages: string[];
}

export interface VersionRow {
  id: string;
  versionNo: number;
  settings: SiteSettings;
  pages: SiteCopy | null;
  kind: 'approved' | 'publish' | 'restore';
  restoredFrom: number | null;
  publishedAt: string;
}

export interface Allowance {
  month: string | null;
  used: number;
}

export type PublishRpc = { result: 'published'; versionNo: number; versionId: string; pruned: string[] } | { result: 'stale' };

export type CopyOutcome = { ok: true; copy: SiteCopy } | { ok: false; message: string };

export interface EditDeps {
  /** The signed-in owner's site, read fresh. Null when there is none. */
  site(): Promise<EditSite | null>;
  now(): Date;
  readDraft(): Promise<EditDraft | null>;
  /** Insert or replace the draft. False when it could not be saved. */
  writeDraft(d: EditDraft): Promise<boolean>;
  deleteDraft(): Promise<boolean>;
  /** website_version_snapshot: the newest version number (1 after the first snapshot), or null on failure. */
  snapshot(): Promise<number | null>;
  /** Every kept version, newest first. */
  listVersions(): Promise<VersionRow[]>;
  /** website_version_publish. Null when the call failed. */
  publish(a: { base: number | null; settings: SiteSettings; pages: SiteCopy; kind: 'publish' | 'restore'; restoredFrom: number | null }): Promise<PublishRpc | null>;
  /** Put the previous version back after a failed fetch: live settings and copy, the new version row removed, the draft back. */
  revert(a: { previous: { settings: SiteSettings; pages: SiteCopy | null }; versionNo: number; draft: EditDraft | null }): Promise<boolean>;
  readAllowance(): Promise<Allowance | null>;
  /** Conditional: only when the stored counter is still `from`. */
  takeAllowance(from: Allowance, to: Allowance): Promise<boolean>;
  /** Conditional: only when the stored counter is still `taken`. */
  giveBackAllowance(taken: Allowance, to: Allowance): Promise<void>;
  /** The copy writer, for these pages only. */
  writeCopy(a: { settings: SiteSettings; only: { pages: CopyPage[]; areas: string[]; base: SiteCopy } }): Promise<CopyOutcome>;
  /** Store an image (PNG or JPEG, sniffed by the real store). */
  uploadImage(bytes: Uint8Array): Promise<{ ok: boolean; url?: string; error?: string }>;
  deleteFile(url: string): Promise<void>;
  fetchPage: PageFetch;
  baseUrl?: string;
  record(kind: 'funnel_edited', opts: { dedupeKey: string; extras: Record<string, string | number | boolean> }): Promise<void>;
}

export type EditFailure =
  | 'no_site'
  | 'paused'
  | 'switched_off'
  | 'not_live'
  | 'unavailable'
  | 'no_draft'
  | 'bad_input'
  | 'allowance'
  | 'copy_failed'
  | 'nothing_to_write'
  | 'not_written'
  | 'pending'
  | 'stale'
  | 'checks'
  | 'pages'
  | 'not_found';

export interface Failed {
  ok: false;
  reason: EditFailure;
  message: string;
  /** Publish's blockers, one plain sentence each. */
  problems?: string[];
  /** Pending pages still to write or approve. */
  pending?: string[];
  /** Publish: the previous version was put back. */
  rolledBack?: boolean;
}

export type Result<T> = ({ ok: true } & T) | Failed;

// ── Pending pages ──

const W = 'w:';
const A = 'a:';

export interface PendingState {
  toWrite: PageRef[];
  toApprove: PageRef[];
}

export function pendingState(pendingPages: readonly string[]): PendingState {
  const out: PendingState = { toWrite: [], toApprove: [] };
  for (const raw of pendingPages) {
    const ref = parsePageRefKey(raw.slice(2));
    if (!ref) continue;
    if (raw.startsWith(W)) out.toWrite.push(ref);
    else if (raw.startsWith(A)) out.toApprove.push(ref);
  }
  return out;
}

/** The page keys still pending, without the prefix, for the screen. */
export const pendingKeys = (pendingPages: readonly string[]): { toWrite: string[]; toApprove: string[] } => {
  const s = pendingState(pendingPages);
  return { toWrite: s.toWrite.map(pageRefKey), toApprove: s.toApprove.map(pageRefKey) };
};

const withoutKey = (pending: readonly string[], key: string): string[] => pending.filter((p) => p.slice(2) !== key);

// ── Messages ──

const MSG = {
  noSite: 'Your website has not been set up for your account yet.',
  paused: 'Your website is paused.',
  switchedOff: 'Your website has been switched off.',
  notLive: 'Your website is not live yet.',
  unavailable: 'We could not do that just now. Please try again.',
  noDraft: 'There are no changes to publish. Start editing first.',
  stale: 'Your site changed since you opened it. Reload the page and try again.',
} as const;

const fail = (reason: EditFailure, message: string, extra: Partial<Failed> = {}): Failed => ({ ok: false, reason, message, ...extra });

/** The fields an edit may change from the screen. A logo or photo only ever arrives through uploadDraftImage. */
const PATCH_FIELDS = ['companyName', 'brandColour', 'areas', 'managementFeePct', 'contactEmail', 'contactPhone', 'aboutText'] as const;
export type DraftPatch = Partial<Pick<SiteSettings, (typeof PATCH_FIELDS)[number]>>;

// ── The run ──

export function createEditRun(deps: EditDeps) {
  async function guard(): Promise<{ ok: true; site: EditSite } | Failed> {
    const site = await deps.site();
    if (!site) return fail('no_site', MSG.noSite);
    if (site.switchedOff) return fail('switched_off', MSG.switchedOff);
    if (site.status === 'paused') return fail('paused', MSG.paused);
    if (site.status !== 'live') return fail('not_live', MSG.notLive);
    if (!site.pages) return fail('unavailable', MSG.unavailable);
    return { ok: true, site };
  }

  const pagesOf = (site: EditSite, settings: SiteSettings, copy: SiteCopy) => buildSitePages({ site: { slug: site.slug, domain: site.domain }, settings, copy: alignCopy(settings.areas, copy) });

  /** The checks over the draft as a visitor would read it: placeholder text, banned claims, an unwritten area, ... */
  function draftProblems(site: EditSite, d: EditDraft): CheckProblem[] {
    return checkSite(pagesOf(site, d.settings, d.pages), { managementFeePct: d.settings.managementFeePct, brandColour: d.settings.brandColour, logoUrl: d.settings.logoUrl }).problems;
  }

  async function openOn(site: EditSite): Promise<Result<{ draft: EditDraft }>> {
    const existing = await deps.readDraft();
    if (existing) return { ok: true, draft: existing };
    const base = await deps.snapshot();
    if (base === null) return fail('unavailable', MSG.unavailable);
    const draft: EditDraft = { settings: site.settings, pages: alignCopy(site.settings.areas, site.pages as SiteCopy), baseVersion: base, pendingPages: [] };
    if (!(await deps.writeDraft(draft))) return fail('unavailable', MSG.unavailable);
    return { ok: true, draft };
  }

  async function openDraft(): Promise<Result<{ draft: EditDraft; problems: CheckProblem[] }>> {
    const g = await guard();
    if (!g.ok) return g;
    const o = await openOn(g.site);
    if (!o.ok) return o;
    return { ok: true, draft: o.draft, problems: draftProblems(g.site, o.draft) };
  }

  async function saveDraftFields(patch: DraftPatch): Promise<Result<{ draft: EditDraft; plan: RewritePlan; problems: CheckProblem[] }>> {
    const g = await guard();
    if (!g.ok) return g;
    const o = await openOn(g.site);
    if (!o.ok) return o;
    const d = o.draft;

    // Only the listed fields: never a logo, photo, status, id or version from a patch.
    const safe: Partial<SiteSettings> = {};
    for (const f of PATCH_FIELDS) if (f in patch && (patch as Record<string, unknown>)[f] !== undefined) (safe as Record<string, unknown>)[f] = (patch as Record<string, unknown>)[f];
    const next: SiteSettings = { ...d.settings, ...safe };

    const plan = pagesToRewrite({ settings: d.settings, copy: d.pages }, { settings: next, copy: null });
    // One block per current area: a new area's block starts empty (the checks block Publish until it is written).
    const pages = alignCopy(next.areas, d.pages);

    let pending = [...d.pendingPages];
    for (const gone of plan.drop) pending = withoutKey(pending, pageRefKey({ page: 'area', area: gone }));
    for (const ref of plan.rewrite) {
      const key = pageRefKey(ref);
      pending = [...withoutKey(pending, key), `${W}${key}`];
    }
    const draft: EditDraft = { settings: next, pages, baseVersion: d.baseVersion, pendingPages: pending };
    if (!(await deps.writeDraft(draft))) return fail('unavailable', MSG.unavailable);
    return { ok: true, draft, plan, problems: draftProblems(g.site, draft) };
  }

  async function rewritePending(): Promise<Result<{ draft: EditDraft; left: number; problems: CheckProblem[] }>> {
    const g = await guard();
    if (!g.ok) return g;
    const d = await deps.readDraft();
    if (!d) return fail('no_draft', MSG.noDraft);
    const todo = pendingState(d.pendingPages).toWrite;
    if (todo.length === 0) return fail('nothing_to_write', 'No pages need writing.');

    // One rewrite, taken atomically: the counter only moves while it is still what we read.
    let from: Allowance | null = null;
    let to: Allowance | null = null;
    for (let tries = 0; tries < 3; tries++) {
      const cur = await deps.readAllowance();
      if (!cur) return fail('unavailable', MSG.unavailable);
      const next = takeRewrite(cur.used, cur.month, deps.now());
      if (!next) return fail('allowance', `You have used all ${WEBSITE_EDIT_REWRITES_PER_MONTH} page rewrites for this month. They start again next month.`);
      if (await deps.takeAllowance(cur, next)) {
        from = cur;
        to = next;
        break;
      }
    }
    if (!from || !to) return fail('unavailable', MSG.unavailable);
    const giveBack = () => deps.giveBackAllowance(to as Allowance, from as Allowance).catch(() => {});

    const kinds = [...new Set(todo.map((r) => r.page))];
    const areas = todo.filter((r) => r.page === 'area').map((r) => r.area ?? '');
    let written: CopyOutcome;
    try {
      written = await deps.writeCopy({ settings: d.settings, only: { pages: kinds, areas, base: d.pages } });
    } catch {
      written = { ok: false, message: MSG.unavailable };
    }
    if (!written.ok) {
      await giveBack();
      return fail('copy_failed', written.message);
    }

    const pages = alignCopy(d.settings.areas, written.copy);
    let pending = [...d.pendingPages];
    for (const ref of todo) {
      const key = pageRefKey(ref);
      pending = [...withoutKey(pending, key), `${A}${key}`];
    }
    const draft: EditDraft = { ...d, pages, pendingPages: pending };
    if (!(await deps.writeDraft(draft))) {
      await giveBack();
      return fail('unavailable', MSG.unavailable);
    }
    return { ok: true, draft, left: rewritesLeft(to.used, to.month, deps.now()), problems: draftProblems(g.site, draft) };
  }

  async function approvePage(key: string): Promise<Result<{ draft: EditDraft }>> {
    const g = await guard();
    if (!g.ok) return g;
    const ref = typeof key === 'string' ? parsePageRefKey(key) : null;
    if (!ref) return fail('bad_input', 'That page could not be found.');
    const d = await deps.readDraft();
    if (!d) return fail('no_draft', MSG.noDraft);
    const k = pageRefKey(ref);
    if (d.pendingPages.includes(`${W}${k}`)) return fail('not_written', 'Write this page first, then approve it.');
    if (!d.pendingPages.includes(`${A}${k}`)) return { ok: true, draft: d };
    const draft: EditDraft = { ...d, pendingPages: withoutKey(d.pendingPages, k) };
    if (!(await deps.writeDraft(draft))) return fail('unavailable', MSG.unavailable);
    return { ok: true, draft };
  }

  /** The operator's own words in a page. A pending page they changed is theirs now: it waits for approval (it no longer needs writing). */
  async function editPage(raw: unknown): Promise<Result<{ draft: EditDraft; problems: CheckProblem[] }>> {
    const g = await guard();
    if (!g.ok) return g;
    const d = await deps.readDraft();
    if (!d) return fail('no_draft', MSG.noDraft);
    const clean = sanitiseCopy(raw);
    if (!clean) return fail('bad_input', 'That copy could not be saved.');
    const pages = alignCopy(d.settings.areas, clean);
    const pending = d.pendingPages.map((p) => {
      const ref = parsePageRefKey(p.slice(2));
      if (!ref) return p;
      return copyTextOf(d.pages, ref) !== copyTextOf(pages, ref) ? `${A}${pageRefKey(ref)}` : p;
    });
    const draft: EditDraft = { ...d, pages, pendingPages: pending };
    if (!(await deps.writeDraft(draft))) return fail('unavailable', MSG.unavailable);
    return { ok: true, draft, problems: draftProblems(g.site, draft) };
  }

  /** What files the live site, the draft and the kept versions refer to, as one set. */
  async function inUse(site: EditSite, draft: EditDraft | null, versions: VersionRow[]): Promise<Set<string>> {
    return filesInUse({ settings: site.settings }, draft ? { settings: draft.settings } : null, versions);
  }

  async function sweep(before: ReadonlySet<string>, after: ReadonlySet<string>): Promise<void> {
    for (const f of filesToDelete(before, after)) {
      try {
        await deps.deleteFile(f);
      } catch {
        // An orphaned file is not worth failing an edit that already went through.
      }
    }
  }

  async function uploadDraftImage(kind: 'logo' | 'photo', bytes: Uint8Array): Promise<Result<{ draft: EditDraft; url: string; problems: CheckProblem[] }>> {
    const g = await guard();
    if (!g.ok) return g;
    const o = await openOn(g.site);
    if (!o.ok) return o;
    const versions = await deps.listVersions();
    const before = await inUse(g.site, o.draft, versions);

    const up = await deps.uploadImage(bytes);
    if (!up.ok || !up.url) return fail('bad_input', up.error ?? 'That image could not be uploaded.');
    const draft: EditDraft = { ...o.draft, settings: { ...o.draft.settings, [kind === 'photo' ? 'photoUrl' : 'logoUrl']: up.url } };
    if (!(await deps.writeDraft(draft))) {
      await deps.deleteFile(up.url).catch(() => {});
      return fail('unavailable', MSG.unavailable);
    }
    // The file replaced is deleted only if nothing else (live, a kept version) still shows it.
    await sweep(before, await inUse(g.site, draft, versions));
    return { ok: true, draft, url: up.url, problems: draftProblems(g.site, draft) };
  }

  /** Publish a settings and copy as a new version, through goLive. Shared by publish and restore. */
  async function publishThrough(site: EditSite, a: { settings: SiteSettings; copy: SiteCopy; kind: 'publish' | 'restore'; restoredFrom: number | null; base: number | null; draft: EditDraft | null }): Promise<Result<{ versionNo: number }>> {
    const versionsBefore = await deps.listVersions();
    const before = await inUse(site, a.draft, versionsBefore);
    const pages = pagesOf(site, a.settings, a.copy);
    const box: { pub: Extract<PublishRpc, { result: 'published' }> | null; stale: boolean } = { pub: null, stale: false };

    const result = await goLive({
      site: { slug: site.slug, domain: site.domain },
      settings: a.settings,
      pages,
      baseUrl: deps.baseUrl,
      fetchPage: deps.fetchPage,
      markLive: async () => {
        const r = await deps.publish({ base: a.base, settings: a.settings, pages: a.copy, kind: a.kind, restoredFrom: a.restoredFrom });
        if (!r) return false;
        if (r.result === 'stale') {
          box.stale = true;
          return false;
        }
        box.pub = r;
        return true;
      },
      // A failed fetch puts the previous version back: the site a visitor sees is the one that worked.
      rollback: async () => (box.pub ? deps.revert({ previous: { settings: site.settings, pages: site.pages }, versionNo: box.pub.versionNo, draft: a.draft }) : false),
      // Approve's activity is not an edit's: this run records its own one event, below.
      record: async () => {},
    });

    if (!result.ok) {
      if (result.stage === 'status') return box.stale ? fail('stale', MSG.stale) : fail('unavailable', MSG.unavailable);
      if (result.stage === 'checks') return fail('checks', 'Your changes cannot be published yet.', { problems: goLiveMessages(result) });
      if (result.stage === 'pages') {
        const messages = goLiveMessages(result);
        return fail('pages', 'Your changes could not be published, so your website has been left as it was.', {
          problems: result.rolledBack ? messages.filter((m) => !/back in preview/.test(m)) : messages,
          rolledBack: result.rolledBack,
        });
      }
      return fail('unavailable', MSG.unavailable);
    }

    const pub = box.pub as unknown as Extract<PublishRpc, { result: 'published' }>;
    try {
      await deps.record('funnel_edited', { dedupeKey: `website_version:${pub.versionId}`, extras: { website: true, version: pub.versionNo } });
    } catch {
      // A missed log line is not a reason to undo a site that is live.
    }
    // The draft is gone and old versions may have been pruned: delete what nothing refers to now.
    const versionsAfter = await deps.listVersions();
    const after = filesInUse({ settings: a.settings }, null, versionsAfter);
    await sweep(before, after);
    return { ok: true, versionNo: pub.versionNo };
  }

  async function publish(): Promise<Result<{ versionNo: number }>> {
    const g = await guard();
    if (!g.ok) return g;
    const d = await deps.readDraft();
    if (!d) return fail('no_draft', MSG.noDraft);
    const p = pendingState(d.pendingPages);
    if (p.toWrite.length > 0 || p.toApprove.length > 0) {
      return fail('pending', p.toWrite.length > 0 ? 'Some pages still need writing. Write them, then approve each one.' : 'Approve each rewritten page before you publish.', { pending: d.pendingPages });
    }
    return publishThrough(g.site, { settings: d.settings, copy: alignCopy(d.settings.areas, d.pages), kind: 'publish', restoredFrom: null, base: d.baseVersion, draft: d });
  }

  /** Restore an old version as a new one. `versionNo` is looked up among THIS site's versions only. */
  async function restore(versionNo: number): Promise<Result<{ versionNo: number }>> {
    const g = await guard();
    if (!g.ok) return g;
    if (!Number.isInteger(versionNo) || versionNo < 1) return fail('bad_input', 'That version could not be found.');
    const versions = await deps.listVersions();
    const v = versions.find((x) => x.versionNo === versionNo);
    if (!v || !v.pages) return fail('not_found', 'That version could not be found.');
    const newest = versions.reduce((n, x) => Math.max(n, x.versionNo), 0);
    const draft = await deps.readDraft();
    return publishThrough(g.site, { settings: v.settings, copy: alignCopy(v.settings.areas, v.pages), kind: 'restore', restoredFrom: versionNo, base: newest, draft });
  }

  async function discardDraft(): Promise<Result<{ discarded: boolean }>> {
    const g = await guard();
    if (!g.ok) return g;
    const d = await deps.readDraft();
    if (!d) return { ok: true, discarded: false };
    const versions = await deps.listVersions();
    const before = await inUse(g.site, d, versions);
    if (!(await deps.deleteDraft())) return fail('unavailable', MSG.unavailable);
    await sweep(before, await inUse(g.site, null, versions));
    return { ok: true, discarded: true };
  }

  /** What the edit screen needs, without opening a draft: status, the draft if there is one, the versions and the allowance. */
  async function state(): Promise<
    | { ok: false; reason: 'no_site' }
    | { ok: true; editable: Failed | null; site: EditSite; draft: EditDraft | null; versions: VersionRow[]; problems: CheckProblem[]; left: number }
  > {
    const site = await deps.site();
    if (!site) return { ok: false, reason: 'no_site' };
    const g = await guard();
    const [draft, versions, allowance] = await Promise.all([deps.readDraft(), deps.listVersions(), deps.readAllowance()]);
    const left = allowance ? rewritesLeft(allowance.used, allowance.month, deps.now()) : 0;
    return { ok: true, editable: g.ok ? null : g, site, draft, versions, problems: draft && site.pages ? draftProblems(site, draft) : [], left };
  }

  return { state, openDraft, saveDraftFields, rewritePending, approvePage, editPage, uploadDraftImage, publish, restore, discardDraft };
}

export type EditRun = ReturnType<typeof createEditRun>;
