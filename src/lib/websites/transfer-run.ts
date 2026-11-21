/**
 * Batch 37 (Phase 5a): the website transfer engine, with every effect injected (the
 * database, the registrar, the clock, the mail, the file store, the page fetch, the
 * site pause and the domain release), so the whole flow runs under node --test with
 * counting fakes. transfer-server.ts (5b) holds the live wiring; the cron
 * (/api/internal/website-transfers) and the operator and admin screens call these.
 *
 * The steps of a transfer, each safe to run again and each claiming its work first:
 *
 *   startTransfer(ownerId, {providerKey, tag?, dryRun})
 *                  canStart's refusals, the provider, the row (method by date, overlap
 *                  end), the domain's renewal stopped, the admin told, the activity
 *                  kind website_transfer_requested. The owner id is ONLY the argument.
 *   buildExport(id)       fetch our own export page for every page (signed token) and
 *                  its stylesheets, fonts and images (each capped by size and time),
 *                  convert (buildStaticSiteReport), add GUIDE.html, zip, upload, stamp
 *                  ready. Three failures: failed + one admin email.
 *   emailExport(id)       direct email outside the daily cap, key
 *                  website-transfer-files:<id>, zip attached under 15 MB else a link
 *   requestDomain(id)     tag: claim tag_claimed_at, ONE changeIpsTag call, refused or
 *                  unclear: manual + admin email, ok: requested. code: the transfer code
 *                  is read, emailed straight to the owner (never stored or logged)
 *   pollDomain(id)        registrar.info(name) === null: moved, ONE email (moved_emailed_at)
 *   alertStuck(id)        one admin email when a requested move has sat for the stuck days
 *   endOverlap(id)        only when overlapDue: claim overlap_ended_at, pause the site if
 *                  live, release the domain (no registrar call), delete the zip. No grace
 *                  episode, no grace email.
 *
 * Admin actions: retryExport, markTagChanged, sendCode (the admin types the code: emailed,
 * never stored, logged or returned), markMoved, cancel (refused once moved; renewal is
 * allowed again), endOverlapNow (the date and the domain wait for nobody), startNewSetup
 * (coming back: the site returns to setup).
 *
 * Every function takes { dryRun }: a dry run reads, writes nothing, sends nothing, claims
 * nothing and calls no registrar write (a counting fake pins it), and returns the plan in words.
 *
 * Log lines carry a short transfer id and a code: never an address, an email, a transfer
 * code, a form body or a zip URL. A stored export_error is a code (200 characters at most).
 *
 * Pure of server-only and the network: injected.
 */
import type { EmailCopy } from '../email/new-lead.ts';
import { isRegistrarError, type Registrar } from '../domains/registrar/types.ts';
import type { PageModel } from './page-model.ts';
import { buildStaticSiteReport, listCssAssets, listPageAssets, type StaticSiteProblem } from './transfer-export.ts';
import { buildGuide, type GuideInput } from './transfer-guide.ts';
import { exportFailedAdminEmail, filesReadyEmail, domainMovedEmail, manualStepAdminEmail, stuckAlertAdminEmail, transferCodeEmail, transferRequestedAdminEmail } from './transfer-emails.ts';
import { providerByKey, resolveProvider } from './transfer-providers.ts';
import { canStart, methodFor, overlapDue, overlapEndsAt, stuckDue, type TransferDomainState, type TransferMethod } from './transfer-rules.ts';
import type { TransferSettings } from './transfer-settings.ts';
import { signTransferToken } from './transfer-token.ts';
import { zipFiles } from './transfer-zip.ts';

// ── Limits ──

/** Three failed builds and the export is failed (the admin retries). */
export const MAX_EXPORT_ATTEMPTS = 3;
/** The zip is attached to the email when it is smaller than this; larger goes as a link. */
export const ATTACH_LIMIT_BYTES = 15 * 1024 * 1024;
/** The download link in the email is good for seven days. */
export const LINK_SECONDS = 7 * 86400;
/** The most one fetched piece may be, and the time one fetch may take. */
export const MAX_PAGE_BYTES = 3 * 1024 * 1024;
export const MAX_CSS_BYTES = 2 * 1024 * 1024;
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 15_000;
/** At most this many fonts and images, and this many bytes in all; the bucket takes 50 MB. */
export const MAX_ASSETS = 150;
export const MAX_ASSET_TOTAL_BYTES = 40 * 1024 * 1024;
export const MAX_ZIP_BYTES = 45 * 1024 * 1024;
const FETCH_PARALLEL = 6;

// ── Shapes ──

/** The website_transfers row, as the engine works with it. */
export interface TransferRow {
  id: string;
  websiteId: string;
  ownerId: string;
  ref: string;
  providerKey: string;
  providerName: string;
  ipsTag: string | null;
  method: TransferMethod;
  domainId: string | null;
  domainName: string | null;
  snapshot: Record<string, unknown>;
  exportState: 'pending' | 'ready' | 'failed';
  exportPath: string | null;
  exportAttempts: number;
  exportError: string | null;
  exportReadyAt: Date | null;
  exportEmailedAt: Date | null;
  domainState: TransferDomainState;
  tagClaimedAt: Date | null;
  domainRequestedAt: Date | null;
  codeSentAt: Date | null;
  domainMovedAt: Date | null;
  stuckAlertedAt: Date | null;
  movedEmailedAt: Date | null;
  overlapEndsAt: Date | null;
  overlapEndedAt: Date | null;
  cancelledAt: Date | null;
  cancelledBy: string | null;
}

/** The columns a claim stamps: "update ... set col = at where id = ? and col is null", true when a row changed. */
export type ClaimColumn = 'tagClaimedAt' | 'codeSentAt' | 'overlapEndedAt' | 'movedEmailedAt' | 'stuckAlertedAt' | 'exportEmailedAt' | 'cancelledAt';

/** The fields a plain write may change. */
export interface TransferPatch {
  exportState?: TransferRow['exportState'];
  exportPath?: string | null;
  exportError?: string | null;
  exportAttempts?: number;
  exportReadyAt?: Date | null;
  domainState?: TransferDomainState;
  domainRequestedAt?: Date | null;
  domainMovedAt?: Date | null;
  cancelledBy?: string | null;
}

/** The owner's own site and everything canStart reads about it. */
export interface StartFacts {
  websiteId: string;
  /** websites.user_id: compared with the id startTransfer was given. */
  ownerId: string;
  status: string;
  deleted: boolean;
  pageCount: number;
  hasOpenTransfer: boolean;
  /** The brand and contact the thank-you page and the export use. */
  settings: { companyName: string; brandColour: string | null; contactEmail: string; contactPhone: string; logoUrl: string | null };
  /** The site's own domain that is not released (live or not), or null. */
  domain: { id: string; name: string; ready: boolean } | null;
}

export interface NewTransfer {
  websiteId: string;
  ownerId: string;
  providerKey: string;
  providerName: string;
  ipsTag: string | null;
  method: TransferMethod;
  domainId: string | null;
  domainName: string | null;
  snapshot: { companyName: string; brandColour: string | null; email: string; phone: string; logoUrl: string | null };
  domainState: TransferDomainState;
  overlapEndsAt: Date;
}

export type InsertResult = { ok: true; id: string; ref: string } | { ok: false; code: 'conflict' | 'unavailable' };

export interface SiteState {
  id: string;
  ownerId: string;
  /** websites.status */
  status: string;
}

export type SendOutcome = { sent: boolean; reason?: string };

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface TransferUrls {
  /** Where we fetch our own export pages from (this deployment). */
  fetchBase: string;
  /** The public address: the exported form's action and every link in an email. */
  publicBase: string;
}

/** What the engine needs from the world. transfer-server.ts (5b) wires the real ones; the tests pass counting fakes. */
export interface TransferDeps {
  now(): Date;
  log(line: string): void;
  settings(): Promise<TransferSettings>;
  urls(): TransferUrls;
  /** Tests only: the token key (the environment's otherwise). */
  tokenKey?: string;

  // Reads
  transfer(id: string): Promise<TransferRow | null>;
  /** The owner's own website (user_id = ownerId) with what canStart needs. Null: none. */
  startFacts(ownerId: string): Promise<StartFacts | null>;
  /** The owner has an unpaid website_domain_charges row while domain_charge_on (grace-server's unpaidDomain, per owner). */
  unpaidDomain(ownerId: string): Promise<boolean>;
  site(websiteId: string): Promise<SiteState | null>;
  /** The owner's address, for an email only (never logged). */
  ownerEmail(ownerId: string): Promise<string | null>;
  /** Every page of the site (buildSitePages), or null when it has none. */
  pages(websiteId: string): Promise<PageModel[] | null>;

  // Writes
  insertTransfer(row: NewTransfer): Promise<InsertResult>;
  patch(id: string, fields: TransferPatch): Promise<boolean>;
  claim(id: string, column: ClaimColumn, at: Date): Promise<boolean>;
  /** Give a claim back (the work after it did not happen), so a later run may do it. */
  unclaim(id: string, column: ClaimColumn): Promise<void>;
  /** export_attempts = expected + 1 where it still equals expected and the state is pending. True: this run owns the attempt. */
  claimExportAttempt(id: string, expectedAttempts: number, at: Date): Promise<boolean>;

  // The site and its domain
  /** blockRenewal(websiteId): the domain stops auto-renewing. True when it is (or there is no domain). */
  blockRenewal(websiteId: string): Promise<boolean>;
  /** allowRenewal(websiteId): the domain may renew again. */
  allowRenewal(websiteId: string): Promise<boolean>;
  /** Batch 36's pause step: live -> paused. False: it did not move. */
  pauseSite(site: SiteState): Promise<boolean>;
  /** purchase-server release(domainId, { registrar: false }). `outcome` is its outcome code. */
  releaseDomain(domainId: string, opts: { registrar: false }): Promise<{ ok: boolean; outcome: string }>;
  /** Coming back: the website row returns to 'setup'. False: it did not move. */
  resetSite(websiteId: string): Promise<boolean>;

  // The registrar (throws RegistrarError not_configured when none is set up)
  registrar(): Registrar;

  // Our files and the network
  storage: {
    upload(path: string, bytes: Uint8Array): Promise<void>;
    download(path: string): Promise<Uint8Array | null>;
    remove(path: string): Promise<void>;
    /** A signed download link, or null. Never logged. */
    signedUrl(path: string, seconds: number): Promise<string | null>;
  };
  fetch(url: string, init: { signal: AbortSignal; redirect: 'manual' }): Promise<Response>;

  // Mail, activity
  /** To the owner, direct (outside the daily cap). */
  sendOwner(to: string, copy: EmailCopy, opts: { idempotencyKey: string; attachments?: MailAttachment[] }): Promise<SendOutcome>;
  /** To the admin(s); true when it went. */
  sendAdmin(copy: EmailCopy, idempotencyKey: string): Promise<boolean>;
  record(userId: string, kind: 'website_transfer_requested', opts: { dedupeKey: string }): Promise<void>;
}

export interface StepResult {
  ok: boolean;
  /** The outcome (ok) or the refusal (not ok), a short code. */
  code: string;
  dryRun: boolean;
  /** What a dry run would do (or a run did), in words. No address, no code. */
  plan?: string[];
  /** The refusal in words for a screen, when it has one. */
  message?: string;
  /** emailExport: how the zip went. */
  detail?: 'attached' | 'link';
}

export interface StartResult extends StepResult {
  id?: string;
  ref?: string;
  method?: TransferMethod;
}

export interface RunOpts {
  dryRun?: boolean;
}

// ── Small helpers ──

/** A short, stable tag for log lines (never an address or a name). */
export const tag = (id: string): string => id.slice(0, 8);

const say = (deps: TransferDeps, id: string, line: string): void => {
  try {
    deps.log(`[website-transfer] ${tag(id)} ${line}`);
  } catch {
    // A logger that throws must not stop a transfer.
  }
};

class ExportError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'ExportError';
    this.code = code;
  }
}

/** A failure as a short code: a registrar code, an export code, else 'error'. Never a message (it may hold an address). */
function codeOf(e: unknown): string {
  if (isRegistrarError(e)) return e.code;
  if (e instanceof ExportError) return e.code;
  return 'error';
}

/** A stored error: a code only, 200 characters at most, nothing that looks like an address or a link. */
export function safeError(code: string): string {
  return code.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 200);
}

const closed = (row: TransferRow): string | null => (row.cancelledAt ? 'cancelled' : row.overlapEndedAt ? 'ended' : null);

const refuse = (code: string, dryRun: boolean, message?: string): StepResult => ({ ok: false, code, dryRun, ...(message ? { message } : {}) });
const done = (code: string, dryRun: boolean, plan?: string[], extra: Partial<StepResult> = {}): StepResult => ({ ok: true, code, dryRun, ...(plan ? { plan } : {}), ...extra });

const dayWords = (d: Date | null): string => (d ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'long', year: 'numeric' }).format(d) : 'the end of the overlap');

const trimSlash = (s: string): string => s.replace(/\/+$/, '');

const siteNameOf = (row: TransferRow): string => (typeof row.snapshot.companyName === 'string' ? row.snapshot.companyName : '');

const panelUrl = (deps: TransferDeps): string => `${trimSlash(deps.urls().publicBase)}/admin/websites`;
const transferPageUrl = (deps: TransferDeps): string => `${trimSlash(deps.urls().publicBase)}/leads/website/transfer`;

/** Tell the admin; never throws; logs a code when it did not go. */
async function tellAdmin(deps: TransferDeps, id: string, copy: EmailCopy, key: string): Promise<boolean> {
  try {
    const sent = await deps.sendAdmin(copy, key);
    if (!sent) say(deps, id, 'admin email not sent');
    return sent;
  } catch {
    say(deps, id, 'admin email failed');
    return false;
  }
}

const providerOf = (row: TransferRow): { name: string; tag: string; helpUrl: string | null } | null => {
  if (row.method === 'none') return null;
  const known = providerByKey(row.providerKey);
  if (known) return { name: known.name, tag: known.tag, helpUrl: known.helpUrl };
  return { name: row.providerName, tag: row.ipsTag ?? '', helpUrl: null };
};

/** The guide input for a transfer: the zip's GUIDE.html and the email use the same one. */
export function guideInputOf(row: TransferRow, publicBase: string): GuideInput {
  return {
    siteName: siteNameOf(row),
    domain: row.method === 'none' ? null : row.domainName,
    method: row.method,
    provider: providerOf(row),
    formAction: `${trimSlash(publicBase)}/api/t/${row.ref}/lead`,
    ourCopyEnds: row.overlapEndsAt ? row.overlapEndsAt.toISOString() : null,
  };
}

// ── Start ──

/**
 * Start a transfer for the owner's own website. `ownerId` is the only identity
 * used: the website is the one that owner holds, and the row is written for that
 * owner. The refusals are canStart's codes (plus the provider's, and 'no_site'
 * and 'unavailable'). A dry run does every check and writes, sends and stops
 * nothing.
 */
export async function startTransfer(deps: TransferDeps, ownerId: string, input: { providerKey?: unknown; tag?: unknown; dryRun?: boolean }): Promise<StartResult> {
  const dry = Boolean(input.dryRun);
  const now = deps.now();
  let facts: StartFacts | null;
  let settings: TransferSettings;
  let unpaid: boolean;
  try {
    [facts, settings, unpaid] = await Promise.all([deps.startFacts(ownerId), deps.settings(), deps.unpaidDomain(ownerId)]);
  } catch {
    return refuse('unavailable', dry, 'Your website could not be read just now. Please try again.');
  }
  if (!facts) return refuse('no_site', dry, 'No website found.');

  const verdict = canStart({
    isOwner: facts.ownerId === ownerId,
    deleted: facts.deleted,
    pageCount: facts.pageCount,
    hasOpenTransfer: facts.hasOpenTransfer,
    hasDomain: facts.domain !== null,
    domainReady: facts.domain?.ready ?? false,
    domainUnpaid: unpaid,
  });
  if (!verdict.ok) return refuse(verdict.code, dry, verdict.message);

  const hasDomain = facts.domain !== null;
  let provider = { key: 'none', name: 'None', tag: '' };
  if (hasDomain) {
    const choice = resolveProvider(input.providerKey, input.tag);
    if (!choice.ok) return refuse(choice.code, dry, choice.message);
    provider = choice;
  }
  const method = methodFor(now, settings.codeFrom, hasDomain);
  const endsAt = overlapEndsAt(now, settings.overlapDays);

  const plan = [
    'Build your website files, with a guide, and email them to you.',
    ...(method === 'tag' ? [`Ask the registrar to move your domain to ${provider.name} (tag ${provider.tag}). If it cannot, we finish that step by hand.`] : []),
    ...(method === 'code' ? ['Email you the transfer code for your domain.'] : []),
    ...(hasDomain ? ['Stop your domain renewing with us.'] : ['You have no domain with us, so only the files are sent.']),
    `Keep our copy of your website running until ${dayWords(endsAt)}${hasDomain ? ', and until your domain has moved' : ''}.`,
    'Tell our team, and note that you asked.',
  ];
  if (dry) return { ...done('would_start', true, plan), method };

  const inserted = await deps.insertTransfer({
    websiteId: facts.websiteId,
    ownerId,
    providerKey: provider.key,
    providerName: provider.name,
    ipsTag: method === 'tag' ? provider.tag : null,
    method,
    domainId: facts.domain?.id ?? null,
    domainName: facts.domain?.name ?? null,
    snapshot: { companyName: facts.settings.companyName, brandColour: facts.settings.brandColour, email: facts.settings.contactEmail, phone: facts.settings.contactPhone, logoUrl: facts.settings.logoUrl },
    domainState: hasDomain ? 'pending' : 'none',
    overlapEndsAt: endsAt,
  });
  if (!inserted.ok) {
    return inserted.code === 'conflict' ? refuse('open_transfer', false, 'A transfer for this website is already under way.') : refuse('unavailable', false, 'Your transfer could not be started just now. Please try again.');
  }
  const id = inserted.id;
  say(deps, id, `started (${method})`);

  if (hasDomain) {
    try {
      if (!(await deps.blockRenewal(facts.websiteId))) say(deps, id, 'renewal not blocked');
    } catch {
      say(deps, id, 'renewal block failed');
    }
  }
  await tellAdmin(
    deps,
    id,
    transferRequestedAdminEmail({ transferId: id, siteName: facts.settings.companyName, domain: facts.domain?.name ?? null, providerName: provider.name, method, tag: method === 'tag' ? provider.tag : null, overlapEndsAt: endsAt.toISOString(), panelUrl: panelUrl(deps) }),
    `website-transfer-admin:requested:${id}`,
  );
  try {
    await deps.record(ownerId, 'website_transfer_requested', { dedupeKey: `website_transfer:${id}` });
  } catch {
    say(deps, id, 'activity not recorded');
  }
  return { ...done('started', false, plan), id, ref: inserted.ref, method };
}

// ── Export ──

async function fetchBytes(deps: TransferDeps, url: string, max: number): Promise<Uint8Array> {
  const res = await deps.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'manual' });
  if (!res.ok) throw new ExportError(`fetch_${res.status}`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) throw new ExportError('fetch_too_big');
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > max) throw new ExportError('fetch_too_big');
  return bytes;
}

const utf8 = (b: Uint8Array): string => Buffer.from(b).toString('utf8');

/** A host we will not fetch from, whatever a page says: loopback, link-local and private ranges, and internal names. */
function privateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.includes(':')) return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h === '::';
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** The absolute address of something a page or sheet names, or null when we will not fetch it (not https and not our own origin, or a private host). */
function fetchable(ref: string, base: string, ownOrigin: string): string | null {
  let u: URL;
  try {
    u = new URL(ref, base);
  } catch {
    return null;
  }
  if (u.origin === ownOrigin) return u.href;
  if (u.protocol !== 'https:' || u.username || u.password || privateHost(u.hostname)) return null;
  return u.href;
}

async function inChunks<T>(items: readonly T[], size: number, each: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(each));
}

/** What the converter reports that means the zip is not fit to send. A missing image or an unresolved link is tolerated (logged as a count). */
const FATAL_PROBLEMS: ReadonlySet<StaticSiteProblem['code']> = new Set(['leak', 'missing_form', 'extra_form', 'no_head', 'missing_stylesheet']);

/** Build the zip for a transfer. Throws an ExportError with a code. */
async function makeZip(deps: TransferDeps, row: TransferRow, now: Date): Promise<{ bytes: Uint8Array; problems: number }> {
  const pages = await deps.pages(row.websiteId);
  if (!pages || pages.length === 0) throw new ExportError('no_pages');
  const token = signTransferToken(row.id, now, deps.tokenKey !== undefined ? { key: deps.tokenKey } : {});
  if (!token) throw new ExportError('no_token');
  const { fetchBase, publicBase } = deps.urls();
  const base = trimSlash(fetchBase);
  const ownOrigin = new URL(base).origin;

  // 1. Every page.
  const htmlByPath: Record<string, string> = {};
  const pageUrls = new Map<string, string>();
  for (const page of pages) {
    const url = page.path === '' ? `${base}/t/export/${token}` : `${base}/t/export/${token}/${page.path}`;
    pageUrls.set(page.path, url);
    htmlByPath[page.path] = utf8(await fetchBytes(deps, url, MAX_PAGE_BYTES));
  }

  // 2. The stylesheets the pages name, then the fonts and images those and the pages name.
  const sheetRefs: Array<{ ref: string; abs: string }> = [];
  const assetUrls = new Set<string>();
  for (const page of pages) {
    const listed = listPageAssets(htmlByPath[page.path]);
    const pageUrl = pageUrls.get(page.path) ?? base;
    for (const ref of listed.stylesheets) {
      if (sheetRefs.some((s) => s.ref === ref)) continue;
      const abs = fetchable(ref, pageUrl, ownOrigin);
      if (!abs) throw new ExportError('stylesheet_blocked');
      sheetRefs.push({ ref, abs });
    }
    for (const ref of listed.images) {
      const abs = fetchable(ref, pageUrl, ownOrigin);
      if (abs) assetUrls.add(abs);
    }
  }
  const css: Array<{ url: string; text: string }> = [];
  for (const s of sheetRefs) {
    let text: string;
    try {
      text = utf8(await fetchBytes(deps, s.abs, MAX_CSS_BYTES));
    } catch (e) {
      throw new ExportError(`stylesheet_${codeOf(e)}`);
    }
    css.push({ url: s.ref, text });
    for (const ref of listCssAssets(text, s.abs)) {
      const abs = fetchable(ref, s.abs, ownOrigin);
      if (abs) assetUrls.add(abs);
    }
  }

  // 3. Fonts and images: one that cannot be had is left out (the converter reports it), never fatal.
  const assets: Record<string, Uint8Array> = {};
  let total = 0;
  const wanted = [...assetUrls].slice(0, MAX_ASSETS);
  await inChunks(wanted, FETCH_PARALLEL, async (abs) => {
    try {
      const bytes = await fetchBytes(deps, abs, MAX_ASSET_BYTES);
      if (total + bytes.length > MAX_ASSET_TOTAL_BYTES) return;
      total += bytes.length;
      assets[abs] = bytes;
    } catch {
      // Left out.
    }
  });

  // 4. Convert, guide, zip.
  let report;
  try {
    report = buildStaticSiteReport({
      pages,
      htmlByPath,
      css,
      assets,
      formAction: `${trimSlash(publicBase)}/api/t/${row.ref}/lead`,
      siteName: siteNameOf(row),
      domain: row.method === 'none' ? null : row.domainName,
    });
  } catch {
    throw new ExportError('convert_failed');
  }
  const fatal = report.problems.find((p) => FATAL_PROBLEMS.has(p.code));
  if (fatal) throw new ExportError(`bad_output_${fatal.code}`);
  const guide = buildGuide(guideInputOf(row, publicBase));
  const bytes = zipFiles({ ...report.files, 'GUIDE.html': guide.html });
  if (bytes.length > MAX_ZIP_BYTES) throw new ExportError('zip_too_big');
  return { bytes, problems: report.problems.length };
}

/**
 * Build the zip for one transfer and stamp it ready. This run must win the attempt
 * (claimExportAttempt), so two runs never build at once. A failure keeps the state
 * pending (the next run tries again) until the third, which marks it failed and
 * tells the admin once. Stored errors are codes.
 */
export async function buildExport(deps: TransferDeps, id: string, opts: RunOpts = {}): Promise<StepResult> {
  const dry = Boolean(opts.dryRun);
  const row = await deps.transfer(id);
  if (!row) return refuse('not_found', dry);
  const c = closed(row);
  if (c) return refuse(c, dry);
  if (row.exportState === 'ready') return done('already_ready', dry);
  if (row.exportState === 'failed' || row.exportAttempts >= MAX_EXPORT_ATTEMPTS) return refuse('failed', dry);
  const plan = ['Fetch every page of the website, with its stylesheets, fonts and images.', 'Turn them into plain files, add the guide, and zip them.', 'Keep the zip in the private file store.'];
  if (dry) return done('would_build', true, plan);

  const now = deps.now();
  if (!(await deps.claimExportAttempt(id, row.exportAttempts, now))) return refuse('claimed_elsewhere', false);
  const attempts = row.exportAttempts + 1;
  try {
    const built = await makeZip(deps, row, now);
    const path = `${row.ownerId}/${row.id}.zip`;
    await deps.storage.upload(path, built.bytes);
    if (!(await deps.patch(id, { exportState: 'ready', exportPath: path, exportError: null, exportReadyAt: now }))) {
      say(deps, id, 'export not stamped');
      return refuse('unavailable', false);
    }
    say(deps, id, `export ready (${built.problems} notes)`);
    return done('built', false, plan);
  } catch (e) {
    const code = safeError(codeOf(e));
    if (attempts >= MAX_EXPORT_ATTEMPTS) {
      await deps.patch(id, { exportState: 'failed', exportError: code }).catch(() => false);
      say(deps, id, `export failed (${code})`);
      await tellAdmin(deps, id, exportFailedAdminEmail({ transferId: id, siteName: siteNameOf(row), code, attempts, panelUrl: panelUrl(deps) }), `website-transfer-admin:export-failed:${id}`);
      return refuse('failed', false);
    }
    await deps.patch(id, { exportError: code }).catch(() => false);
    say(deps, id, `export attempt ${attempts} failed (${code})`);
    return refuse('retry', false);
  }
}

/**
 * Email the files: direct (outside the daily cap), key website-transfer-files:<id>,
 * the zip attached when it is under 15 MB, otherwise a download link only. Claims
 * export_emailed_at first and gives the claim back when the email did not go.
 */
export async function emailExport(deps: TransferDeps, id: string, opts: RunOpts = {}): Promise<StepResult> {
  const dry = Boolean(opts.dryRun);
  const row = await deps.transfer(id);
  if (!row) return refuse('not_found', dry);
  const c = closed(row);
  if (c) return refuse(c, dry);
  if (row.exportState !== 'ready' || !row.exportPath) return refuse('not_ready', dry);
  if (row.exportEmailedAt) return done('already_emailed', dry);
  const to = await deps.ownerEmail(row.ownerId);
  if (!to) return refuse('no_recipient', dry);
  const plan = ['Email the owner the guide, with the zip attached when it is under 15 MB, or a download link when it is not.'];
  if (dry) return done('would_email', true, plan);

  const now = deps.now();
  if (!(await deps.claim(id, 'exportEmailedAt', now))) return refuse('claimed_elsewhere', false);
  const give = async (code: string): Promise<StepResult> => {
    await deps.unclaim(id, 'exportEmailedAt').catch(() => undefined);
    say(deps, id, `files email not sent (${code})`);
    return refuse(code, false);
  };
  let bytes: Uint8Array | null;
  try {
    bytes = await deps.storage.download(row.exportPath);
  } catch {
    return give('zip_unreadable');
  }
  if (!bytes) return give('zip_missing');
  const attached = bytes.length < ATTACH_LIMIT_BYTES;
  let link: string | null = null;
  if (!attached) {
    try {
      link = await deps.storage.signedUrl(row.exportPath, LINK_SECONDS);
    } catch {
      link = null;
    }
    if (!link) return give('link_failed');
  }
  const { publicBase } = deps.urls();
  const copy = filesReadyEmail({ siteName: siteNameOf(row), guideText: buildGuide(guideInputOf(row, publicBase)).text, attached, downloadUrl: link, ourCopyEnds: row.overlapEndsAt ? row.overlapEndsAt.toISOString() : null, transferPageUrl: transferPageUrl(deps) });
  let out: SendOutcome;
  try {
    out = await deps.sendOwner(to, copy, { idempotencyKey: `website-transfer-files:${id}`, ...(attached ? { attachments: [{ filename: 'website-files.zip', content: Buffer.from(bytes), contentType: 'application/zip' }] } : {}) });
  } catch {
    out = { sent: false, reason: 'error' };
  }
  if (!out.sent) return give(safeError(out.reason ?? 'send_failed'));
  say(deps, id, `files emailed (${attached ? 'attached' : 'link'})`);
  return done('emailed', false, plan, { detail: attached ? 'attached' : 'link' });
}

// ── The domain ──

/**
 * Ask for the domain to move.
 *   tag:  claim tag_claimed_at (only the claimer goes on), call changeIpsTag ONCE. Refused or
 *         unclear: manual and one admin email. Done: requested.
 *   code: read the transfer code and email it straight to the owner (never stored or logged).
 *         Refused: manual and one admin email.
 * A registrar that is not set up gives the claim back and waits.
 */
export async function requestDomain(deps: TransferDeps, id: string, opts: RunOpts = {}): Promise<StepResult> {
  const dry = Boolean(opts.dryRun);
  const row = await deps.transfer(id);
  if (!row) return refuse('not_found', dry);
  const c = closed(row);
  if (c) return refuse(c, dry);
  if (row.method === 'none' || !row.domainName) return refuse('no_domain', dry);
  if (row.domainState !== 'pending') return refuse('not_pending', dry);
  const plan = row.method === 'tag' ? ['Ask the registrar, once, to change the domain\'s tag to the new provider\'s.', 'If it cannot, mark the step manual and tell the admin.'] : ['Read the domain\'s transfer code and email it to the owner.', 'If it cannot be read, mark the step manual and tell the admin.'];
  if (dry) return done('would_request', true, plan);

  const now = deps.now();
  const column: ClaimColumn = row.method === 'tag' ? 'tagClaimedAt' : 'codeSentAt';
  if (!(await deps.claim(id, column, now))) return refuse('claimed_elsewhere', false);
  const give = async (code: string): Promise<StepResult> => {
    await deps.unclaim(id, column).catch(() => undefined);
    say(deps, id, `domain not requested (${code})`);
    return refuse(code, false);
  };
  const manual = async (reason: string): Promise<StepResult> => {
    await deps.patch(id, { domainState: 'manual' });
    say(deps, id, `manual step (${row.method}, ${reason})`);
    await tellAdmin(
      deps,
      id,
      manualStepAdminEmail({ transferId: id, domain: row.domainName ?? '', providerName: row.providerName, step: row.method === 'tag' ? 'tag' : 'code', tag: row.ipsTag, reason, panelUrl: panelUrl(deps) }),
      `website-transfer-admin:manual:${id}`,
    );
    return done('manual', false, plan);
  };

  let registrar: Registrar;
  try {
    registrar = deps.registrar();
  } catch {
    return give('not_configured');
  }

  if (row.method === 'tag') {
    try {
      await registrar.changeIpsTag(row.domainName, row.ipsTag ?? '');
    } catch (e) {
      const code = codeOf(e);
      // 'not_configured' means nothing was called. Anything else may have happened: it is never retried blind, an admin looks.
      if (code === 'not_configured') return give(code);
      return manual(code);
    }
    await deps.patch(id, { domainState: 'requested', domainRequestedAt: now });
    say(deps, id, 'tag change requested');
    return done('requested', false, plan);
  }

  // The transfer code: held only in this function, emailed, then gone.
  let secret: string;
  try {
    secret = await registrar.transferCode(row.domainName);
  } catch (e) {
    const code = codeOf(e);
    if (code === 'not_configured') return give(code);
    await deps.unclaim(id, column).catch(() => undefined);
    return manual(code);
  }
  const to = await deps.ownerEmail(row.ownerId);
  if (!to) return give('no_recipient');
  let out: SendOutcome;
  try {
    out = await deps.sendOwner(to, transferCodeEmail({ siteName: siteNameOf(row), domain: row.domainName, code: secret, providerName: row.providerName }), { idempotencyKey: `website-transfer-code:${id}` });
  } catch {
    out = { sent: false, reason: 'error' };
  }
  if (!out.sent) return give(safeError(out.reason ?? 'send_failed'));
  await deps.patch(id, { domainState: 'requested', domainRequestedAt: now });
  say(deps, id, 'transfer code emailed');
  return done('requested', false, plan);
}

/** The "your domain has moved" email, once: moved_emailed_at is claimed first and given back if the email did not go. */
async function sendMoved(deps: TransferDeps, row: TransferRow, now: Date): Promise<'emailed' | 'already_emailed' | 'no_recipient' | 'email_failed'> {
  if (!(await deps.claim(row.id, 'movedEmailedAt', now))) return 'already_emailed';
  const to = await deps.ownerEmail(row.ownerId);
  if (!to) {
    say(deps, row.id, 'moved email not sent (no_recipient)');
    return 'no_recipient';
  }
  let out: SendOutcome;
  try {
    out = await deps.sendOwner(to, domainMovedEmail({ siteName: siteNameOf(row), domain: row.domainName ?? '', ourCopyEnds: row.overlapEndsAt ? row.overlapEndsAt.toISOString() : null, transferPageUrl: transferPageUrl(deps) }), { idempotencyKey: `website-transfer-moved:${row.id}` });
  } catch {
    out = { sent: false };
  }
  if (!out.sent) {
    await deps.unclaim(row.id, 'movedEmailedAt').catch(() => undefined);
    say(deps, row.id, 'moved email not sent');
    return 'email_failed';
  }
  return 'emailed';
}

/** Has the domain left our account? registrar.info(name) === null: it has. Then moved, and the owner is emailed once. */
export async function pollDomain(deps: TransferDeps, id: string, opts: RunOpts = {}): Promise<StepResult> {
  const dry = Boolean(opts.dryRun);
  const row = await deps.transfer(id);
  if (!row) return refuse('not_found', dry);
  const c = closed(row);
  if (c) return refuse(c, dry);
  if (!row.domainName || row.method === 'none') return refuse('no_domain', dry);
  if (row.domainState === 'moved') {
    if (dry || row.movedEmailedAt) return done('already_moved', dry);
    // Moved earlier but the email never went (or an admin marked it): finish it.
    const sent = await sendMoved(deps, row, deps.now());
    return done(sent === 'emailed' ? 'moved' : 'already_moved', false);
  }
  if (row.domainState !== 'requested') return refuse('not_requested', dry);
  let still: unknown;
  try {
    still = await deps.registrar().info(row.domainName);
  } catch (e) {
    say(deps, id, `poll failed (${codeOf(e)})`);
    return refuse(codeOf(e) === 'not_configured' ? 'not_configured' : 'registrar_error', dry);
  }
  if (still !== null) return done('still_ours', dry);
  const plan = ['Mark the domain as moved.', 'Email the owner once to say so.'];
  if (dry) return done('would_mark_moved', true, plan);
  const now = deps.now();
  await deps.patch(id, { domainState: 'moved', domainMovedAt: now });
  say(deps, id, 'domain moved');
  await sendMoved(deps, { ...row, domainState: 'moved', domainMovedAt: now }, now);
  return done('moved', false, plan);
}

/** A requested move that has sat for the stuck days: ONE admin email (claimed on stuck_alerted_at). */
export async function alertStuck(deps: TransferDeps, id: string, opts: RunOpts = {}): Promise<StepResult> {
  const dry = Boolean(opts.dryRun);
  const row = await deps.transfer(id);
  if (!row) return refuse('not_found', dry);
  const c = closed(row);
  if (c) return refuse(c, dry);
  const settings = await deps.settings();
  const now = deps.now();
  if (!row.domainName || !stuckDue({ domain_state: row.domainState, domain_requested_at: row.domainRequestedAt, stuck_alerted_at: row.stuckAlertedAt, cancelled_at: row.cancelledAt }, now, settings.stuckDays)) return refuse('not_stuck', dry);
  const plan = ['Tell the admin, once, that the domain move has sat too long.'];
  if (dry) return done('would_alert', true, plan);
  if (!(await deps.claim(id, 'stuckAlertedAt', now))) return refuse('claimed_elsewhere', false);
  const sent = await tellAdmin(
    deps,
    id,
    stuckAlertAdminEmail({ transferId: id, domain: row.domainName, method: row.method, providerName: row.providerName, requestedAt: row.domainRequestedAt ? row.domainRequestedAt.toISOString() : null, stuckDays: settings.stuckDays, panelUrl: panelUrl(deps) }),
    `website-transfer-admin:stuck:${id}`,
  );
  if (!sent) {
    await deps.unclaim(id, 'stuckAlertedAt').catch(() => undefined);
    return refuse('email_failed', false);
  }
  say(deps, id, 'stuck alert sent');
  return done('alerted', false, plan);
}

// ── The end of the overlap ──

async function endOverlapCore(deps: TransferDeps, row: TransferRow, o: { forced: boolean; dryRun: boolean }): Promise<StepResult> {
  const dry = o.dryRun;
  const now = deps.now();
  const c = closed(row);
  if (c) return refuse(c, dry);
  if (!o.forced && !overlapDue({ overlap_ends_at: row.overlapEndsAt, domain_state: row.domainState, overlap_ended_at: row.overlapEndedAt, cancelled_at: row.cancelledAt }, now)) return refuse('not_due', dry);
  const plan = [
    'Pause our copy of the website if it is live.',
    ...(row.domainId ? ['Take the domain off the website (it has left our registrar account, so no registrar call).'] : []),
    'Delete the zip of the files.',
    'No switch-off warning and no grace period: the transfer is the reason.',
  ];
  if (dry) return done('would_end', true, plan);

  if (!(await deps.claim(row.id, 'overlapEndedAt', now))) return refuse('claimed_elsewhere', false);
  const give = async (code: string): Promise<StepResult> => {
    await deps.unclaim(row.id, 'overlapEndedAt').catch(() => undefined);
    say(deps, row.id, `overlap not ended (${code})`);
    return refuse(code, false);
  };
  try {
    const site = await deps.site(row.websiteId);
    if (site && site.status === 'live' && !(await deps.pauseSite(site))) return give('pause_failed');
  } catch {
    return give('pause_failed');
  }
  if (row.domainId) {
    try {
      const released = await deps.releaseDomain(row.domainId, { registrar: false });
      // A domain already released reads as "bad_status": done earlier, nothing left to do.
      if (!released.ok && released.outcome !== 'bad_status') return give('release_failed');
    } catch {
      return give('release_failed');
    }
  }
  if (row.exportPath) {
    try {
      await deps.storage.remove(row.exportPath);
      await deps.patch(row.id, { exportPath: null });
    } catch {
      say(deps, row.id, 'zip not deleted');
    }
  }
  say(deps, row.id, o.forced ? 'overlap ended (forced)' : 'overlap ended');
  return done('ended', false, plan);
}

/** The overlap ends, once, when overlapDue says so: 30 days gone AND the domain moved (or none), never earlier. */
export async function endOverlap(deps: TransferDeps, id: string, opts: RunOpts = {}): Promise<StepResult> {
  const row = await deps.transfer(id);
  if (!row) return refuse('not_found', Boolean(opts.dryRun));
  return endOverlapCore(deps, row, { forced: false, dryRun: Boolean(opts.dryRun) });
}

// ── Admin actions ──

/** A failed export is built again from the start (the attempts are given back). */
export async function retryExport(deps: TransferDeps, id: string, opts: RunOpts = {}): Promise<StepResult> {
  const dry = Boolean(opts.dryRun);
  const row = await deps.transfer(id);
  if (!row) return refuse('not_found', dry);
  const c = closed(row);
  if (c) return refuse(c, dry);
  if (row.exportState !== 'failed') return refuse('not_failed', dry);
  const plan = ['Put the export back to pending with no failed attempts; the next run builds it again.'];
  if (dry) return done('would_retry', true, plan);
  if (!(await deps.patch(id, { exportState: 'pending', exportAttempts: 0, exportError: null }))) return refuse('unavailable', false);
  say(deps, id, 'export retry');
  return done('retried', false, plan);
}

/** The admin changed the tag by hand: the move is now tracked. The automatic call is never made afterwards. */
export async function markTagChanged(deps: TransferDeps, id: string, opts: RunOpts = {}): Promise<StepResult> {
  const dry = Boolean(opts.dryRun);
  const row = await deps.transfer(id);
  if (!row) return refuse('not_found', dry);
  const c = closed(row);
  if (c) return refuse(c, dry);
  if (row.method !== 'tag' || !row.domainName) return refuse('not_tag_method', dry);
  if (row.domainState !== 'manual' && row.domainState !== 'pending') return refuse(row.domainState === 'none' ? 'no_domain' : 'not_manual', dry);
  const plan = ['Mark the domain move as requested and start watching it.', 'The automatic tag change is not tried after this.'];
  if (dry) return done('would_mark', true, plan);
  const now = deps.now();
  await deps.claim(id, 'tagClaimedAt', now);
  if (!(await deps.patch(id, { domainState: 'requested', domainRequestedAt: now }))) return refuse('unavailable', false);
  say(deps, id, 'tag marked changed');
  return done('requested', false, plan);
}

/** A transfer code an admin may type: printable, no spaces, 3 to 80 characters. */
const CODE_SHAPE = /^[\x21-\x7e]{3,80}$/;

/**
 * The admin typed the transfer code: it is emailed to the owner and that is all. It is
 * not stored, not logged, not in a plan and not in the result.
 */
export async function sendCode(deps: TransferDeps, id: string, code: unknown, opts: RunOpts = {}): Promise<StepResult> {
  const dry = Boolean(opts.dryRun);
  const row = await deps.transfer(id);
  if (!row) return refuse('not_found', dry);
  const c = closed(row);
  if (c) return refuse(c, dry);
  if (row.method === 'none' || !row.domainName) return refuse('no_domain', dry);
  if (row.domainState === 'moved') return refuse('moved', dry);
  const typed = typeof code === 'string' ? code.trim() : '';
  if (!CODE_SHAPE.test(typed)) return refuse('bad_code', dry, 'That does not look like a transfer code.');
  const to = await deps.ownerEmail(row.ownerId);
  if (!to) return refuse('no_recipient', dry);
  const plan = ['Email the code you typed to the account owner. It is not stored.', 'Mark the domain move as requested.'];
  if (dry) return done('would_send', true, plan);
  const now = deps.now();
  let out: SendOutcome;
  try {
    out = await deps.sendOwner(to, transferCodeEmail({ siteName: siteNameOf(row), domain: row.domainName, code: typed, providerName: row.providerName }), { idempotencyKey: `website-transfer-code:${id}:${now.getTime()}` });
  } catch {
    out = { sent: false, reason: 'error' };
  }
  if (!out.sent) {
    say(deps, id, 'code email not sent');
    return refuse(safeError(out.reason ?? 'send_failed'), false);
  }
  await deps.claim(id, 'codeSentAt', now);
  if (row.domainState !== 'requested' || !row.domainRequestedAt) await deps.patch(id, { domainState: 'requested', domainRequestedAt: row.domainRequestedAt ?? now });
  say(deps, id, 'code emailed by admin');
  return done('sent', false, plan);
}

/** The admin says the domain has moved: moved, and the owner is emailed once (the same email as the poll's). */
export async function markMoved(deps: TransferDeps, id: string, opts: RunOpts = {}): Promise<StepResult> {
  const dry = Boolean(opts.dryRun);
  const row = await deps.transfer(id);
  if (!row) return refuse('not_found', dry);
  const c = closed(row);
  if (c) return refuse(c, dry);
  if (row.method === 'none' || !row.domainName) return refuse('no_domain', dry);
  if (row.domainState === 'moved') return done('already_moved', dry);
  const plan = ['Mark the domain as moved.', 'Email the owner once to say so.'];
  if (dry) return done('would_mark_moved', true, plan);
  const now = deps.now();
  if (!(await deps.patch(id, { domainState: 'moved', domainMovedAt: now }))) return refuse('unavailable', false);
  say(deps, id, 'marked moved');
  await sendMoved(deps, { ...row, domainState: 'moved', domainMovedAt: now }, now);
  return done('moved', false, plan);
}

/**
 * Cancel a transfer: only before the domain has moved (and before the overlap has ended). The
 * domain may renew again; the zip is deleted. If renewal cannot be allowed the cancel is given back.
 */
export async function cancel(deps: TransferDeps, id: string, opts: RunOpts & { by?: string } = {}): Promise<StepResult> {
  const dry = Boolean(opts.dryRun);
  const row = await deps.transfer(id);
  if (!row) return refuse('not_found', dry);
  if (row.cancelledAt) return refuse('cancelled', dry);
  if (row.domainState === 'moved') return refuse('moved', dry, 'The domain has already moved, so this cannot be cancelled.');
  if (row.overlapEndedAt) return refuse('ended', dry);
  const plan = ['Cancel the transfer.', ...(row.domainId ? ['Let the domain renew again.'] : []), 'Delete the zip of the files.'];
  if (dry) return done('would_cancel', true, plan);
  const now = deps.now();
  if (!(await deps.claim(id, 'cancelledAt', now))) return refuse('claimed_elsewhere', false);
  if (row.domainId) {
    let allowed = false;
    try {
      allowed = await deps.allowRenewal(row.websiteId);
    } catch {
      allowed = false;
    }
    if (!allowed) {
      await deps.unclaim(id, 'cancelledAt').catch(() => undefined);
      say(deps, id, 'cancel not done (renewal_failed)');
      return refuse('renewal_failed', false);
    }
  }
  await deps.patch(id, { cancelledBy: opts.by ?? null }).catch(() => false);
  if (row.exportPath) {
    try {
      await deps.storage.remove(row.exportPath);
      await deps.patch(id, { exportPath: null });
    } catch {
      say(deps, id, 'zip not deleted');
    }
  }
  say(deps, id, 'cancelled');
  return done('cancelled', false, plan);
}

/** "End overlap now": our copy stops without waiting for the date or for the domain. Same steps and claim as endOverlap, forced. */
export async function endOverlapNow(deps: TransferDeps, id: string, opts: RunOpts = {}): Promise<StepResult> {
  const row = await deps.transfer(id);
  if (!row) return refuse('not_found', Boolean(opts.dryRun));
  return endOverlapCore(deps, row, { forced: true, dryRun: Boolean(opts.dryRun) });
}

/**
 * Coming back: after a transfer has ended, the site returns to setup (one site per member; the
 * old exported form keeps working because the transfer row stays).
 */
export async function startNewSetup(deps: TransferDeps, id: string, opts: RunOpts = {}): Promise<StepResult> {
  const dry = Boolean(opts.dryRun);
  const row = await deps.transfer(id);
  if (!row) return refuse('not_found', dry);
  if (row.cancelledAt) return refuse('cancelled', dry);
  if (!row.overlapEndedAt) return refuse('not_ended', dry);
  const site = await deps.site(row.websiteId);
  if (!site) return refuse('no_site', dry);
  if (site.status === 'setup') return done('already_setup', dry);
  const plan = ['Put the website back to setup so the owner can build it again.', 'The exported form keeps working.'];
  if (dry) return done('would_reset', true, plan);
  if (!(await deps.resetSite(row.websiteId))) return refuse('conflict', false);
  say(deps, id, 'new setup started');
  return done('reset', false, plan);
}
