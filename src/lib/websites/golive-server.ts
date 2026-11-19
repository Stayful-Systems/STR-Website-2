/**
 * Batch 31, Phase 10: the Approve button's orchestration. Pure: every effect
 * (fetching a page, moving the status, logging activity) is passed in, so the
 * whole thing runs under node --test with a fake fetch and no server. The
 * setup actions (src/app/leads/setup/website/actions.ts) wire the real ones.
 *
 * What Approve does, in this order:
 *
 *   1. checkSite over the pages the visitor would read (placeholder text such
 *      as `{{`, required fields, UK phone and email, banned claims, the form).
 *      Any problem blocks Approve BEFORE the status moves: the site is never
 *      live with a known problem. The problems come back as a list.
 *   2. markLive: preview -> live (approved_at and live_at stamped).
 *   3. Fetch EVERY public page of the site: home, each area, fees, about, faq
 *      and privacy. Each must answer 200 (a redirect is not a 200), contain
 *      no placeholder text once scripts and tags are stripped, and, except
 *      the privacy page, contain the lead form.
 *   4. On ANY failure (or a fetch that throws): rollback to preview and say
 *      which pages failed and why. The member fixes it and approves again.
 *   5. On success: activity `website_approved` and `funnel_live` (the latter
 *      with dedupe key `website_live`). Activity only: no conversion event
 *      anywhere (issue #18), so this file never imports the Meta conversions
 *      module and a pin test holds it to that.
 *
 * The address fetched is the app's own absolute-URL helper (`siteUrl`, the
 * configured site base, never the request's Host header) followed by
 * `siteHref(site, path)`, the one way a site's pages are addressed, so a later
 * custom domain changes urls.ts and nothing here.
 */
import { siteUrl } from '../url.ts';
import { PAGES_NEEDING_FORM, checkSite, placeholderHits, type CheckProblem } from './checks.ts';
import type { PageModel, SiteSettings } from './page-model.ts';
import { siteHref } from './urls.ts';
import type { SiteRef } from './types.ts';

/** Slow pages are a failure too: Approve must not hang. */
export const PAGE_TIMEOUT_MS = 15_000;

/** The least of a Response this file reads. */
export interface FetchedPage {
  status: number;
  text(): Promise<string>;
}

export interface PageFetchInit {
  redirect: 'manual';
  cache: 'no-store';
  signal?: AbortSignal;
}

export type PageFetch = (url: string, init: PageFetchInit) => Promise<FetchedPage>;

export type GoLiveEvent = 'website_approved' | 'funnel_live';

/**
 * The dedupe key each go-live event carries. `funnel_live` is the plan's
 * `website_live`. The two must differ: activity_events is unique on
 * (user_id, dedupe_key) whatever the kind, so a shared key would drop the second event.
 */
export const GO_LIVE_DEDUPE: Record<GoLiveEvent, string> = { website_approved: 'website_approved', funnel_live: 'website_live' };

export interface GoLiveDeps {
  site: SiteRef;
  /** The member's settings as stored: the checks compare the fee, colour and logo as typed. */
  settings: Pick<SiteSettings, 'managementFeePct' | 'brandColour' | 'logoUrl'>;
  /** The site's page model (sitePagesOf), or null when there is no copy yet. */
  pages: readonly PageModel[] | null;
  /** The base the pages are fetched from. Default: the app's configured site URL (siteUrl()). */
  baseUrl?: string;
  fetchPage: PageFetch;
  timeoutMs?: number;
  /** preview -> live. False when it did not move (someone else changed the status first). */
  markLive: () => Promise<boolean>;
  /** live -> preview. False when it could not be put back (the result says so). */
  rollback: () => Promise<boolean>;
  /** Activity only. Never throws into Approve: a failed write cannot undo a site that is live. */
  record: (kind: GoLiveEvent, opts: { dedupeKey: string; extras?: Record<string, string | number | boolean> }) => Promise<void>;
}

export type PageFailureReason = 'status' | 'fetch' | 'placeholder' | 'no_form';

export interface PageFailure {
  /** "" is the home page, then "areas/leeds", "fees", ... as in the page model. */
  path: string;
  reason: PageFailureReason;
  /** A short plain-words detail ("returned 404", "has leftover text: ..."). Never a page's full text. */
  detail: string;
}

export type GoLiveResult =
  | { ok: true; pages: string[] }
  | { ok: false; stage: 'checks'; problems: CheckProblem[] }
  | { ok: false; stage: 'no_pages' }
  | { ok: false; stage: 'status' }
  | { ok: false; stage: 'pages'; failures: PageFailure[]; rolledBack: boolean };

// ── Reading a fetched page ──

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** The text a visitor would read: scripts, styles and comments dropped, tags removed, entities decoded. */
export function visibleText(html: string): string {
  return String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (m, hex, dec, name) => {
      if (name) return ENTITIES[name.toLowerCase()] ?? m;
      const code = hex ? parseInt(hex, 16) : parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whether the page has the two-step lead form's first step: a form, an email box and the consent checkbox. */
export function hasLeadForm(html: string): boolean {
  const h = String(html ?? '');
  return /<form\b/i.test(h) && /\bname="email"/i.test(h) && /\btype="checkbox"/i.test(h);
}

/** What is wrong with one fetched page, or null. Pure. */
export function pageFailure(page: Pick<PageModel, 'key' | 'path'>, res: { status: number; html: string }): PageFailure | null {
  if (res.status !== 200) return { path: page.path, reason: 'status', detail: `returned ${res.status}` };
  const hits = placeholderHits(visibleText(res.html));
  if (hits.length > 0) return { path: page.path, reason: 'placeholder', detail: `has leftover text: "${hits[0].excerpt}"` };
  if (PAGES_NEEDING_FORM.includes(page.key) && !hasLeadForm(res.html)) return { path: page.path, reason: 'no_form', detail: 'is missing the lead form' };
  return null;
}

const label = (path: string) => (path ? path.replace(/^areas\//, 'the ') + (path.startsWith('areas/') ? ' area' : '') : 'home');

/** A failure in words for the member, e.g. "The fees page returned 404." */
export function describeFailure(f: PageFailure): string {
  const name = label(f.path);
  return `The ${name.startsWith('the ') ? name.slice(4) : name} page ${f.detail}.`;
}

/** The whole result in words (one line per problem), for the setup page. */
export function goLiveMessages(r: GoLiveResult): string[] {
  if (r.ok) return [];
  switch (r.stage) {
    case 'checks':
      return r.problems.map((p) => `${p.page === 'site' ? 'Your details' : `The ${label(p.page)} page`}: ${p.message}`);
    case 'no_pages':
      return ['Write your site first: there are no pages to publish yet.'];
    case 'status':
      return ['Your website could not be put live just now. Please try again.'];
    case 'pages':
      return [...r.failures.map(describeFailure), r.rolledBack ? 'Your website is back in preview. Fix this and approve again.' : 'We could not put your website back in preview. Please contact us.'];
  }
}

// ── The orchestration ──

/** The address of one page: the app's configured base, then the site's own path. */
export function pageUrl(base: string, site: SiteRef, path: string): string {
  return `${base.replace(/\/+$/, '')}${siteHref(site, path)}`;
}

async function fetchOne(deps: GoLiveDeps, base: string, page: PageModel): Promise<PageFailure | null> {
  const url = pageUrl(base, deps.site, page.path);
  try {
    const signal = typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(deps.timeoutMs ?? PAGE_TIMEOUT_MS) : undefined;
    const res = await deps.fetchPage(url, { redirect: 'manual', cache: 'no-store', signal });
    // The body only matters for a 200: anything else already fails.
    const html = res.status === 200 ? await res.text() : '';
    return pageFailure(page, { status: res.status, html });
  } catch {
    return { path: page.path, reason: 'fetch', detail: 'could not be reached' };
  }
}

export async function goLive(deps: GoLiveDeps): Promise<GoLiveResult> {
  const pages = deps.pages;
  if (!pages || pages.length === 0) return { ok: false, stage: 'no_pages' };

  // 1. Checks first: nothing goes live with a known problem.
  const checked = checkSite(pages, { managementFeePct: deps.settings.managementFeePct, brandColour: deps.settings.brandColour, logoUrl: deps.settings.logoUrl });
  if (!checked.ok) return { ok: false, stage: 'checks', problems: checked.problems };

  // 2. Live.
  let moved = false;
  try {
    moved = await deps.markLive();
  } catch {
    moved = false;
  }
  if (!moved) return { ok: false, stage: 'status' };

  // 3. Every public page, as the public would get it.
  const base = deps.baseUrl ?? siteUrl();
  let failures: PageFailure[];
  try {
    const results = await Promise.all(pages.map((p) => fetchOne(deps, base, p)));
    failures = results.filter((f): f is PageFailure => f !== null);
  } catch {
    failures = [{ path: '', reason: 'fetch', detail: 'could not be reached' }];
  }

  // 4. Any failure: back to preview.
  if (failures.length > 0) {
    let rolledBack = false;
    try {
      rolledBack = await deps.rollback();
    } catch {
      rolledBack = false;
    }
    return { ok: false, stage: 'pages', failures, rolledBack };
  }

  // 5. Live and verified: activity only.
  for (const kind of ['website_approved', 'funnel_live'] as const) {
    try {
      await deps.record(kind, { dedupeKey: GO_LIVE_DEDUPE[kind] });
    } catch {
      // A missed log line is not a reason to undo a live site.
    }
  }
  return { ok: true, pages: pages.map((p) => p.path) };
}
