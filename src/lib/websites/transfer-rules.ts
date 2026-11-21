/**
 * Batch 37: when a website may be transferred to its operator, how the domain
 * moves, and when the overlap and the "stuck" alert are due, as pure rules. The
 * server code, the cron and the screens all ask these, so the answer is the same
 * everywhere. Nothing here reads a clock, a database or a network.
 *
 * Method: a .uk domain moves by IPS tag before website_transfer_code_from
 * (9 Feb 2027, when Nominet retires the tag) and by transfer code from that day.
 * No domain means there is nothing to move: files only.
 *
 * Overlap (Zac, Q-D): our copy keeps serving for the overlap days, and stops only
 * once the domain has moved (or there is none), or when admin forces it.
 */

export type TransferMethod = 'tag' | 'code' | 'none';
export type TransferDomainState = 'none' | 'pending' | 'manual' | 'requested' | 'moved';

const DAY_MS = 86400000;

/**
 * The method for a transfer started `now`. `codeFrom` is YYYY-MM-DD (UTC midnight;
 * on that day and after, the code is the method).
 */
export function methodFor(now: Date, codeFrom: string, hasDomain: boolean): TransferMethod {
  if (!hasDomain) return 'none';
  const from = Date.parse(`${codeFrom}T00:00:00Z`);
  if (!Number.isFinite(from)) return 'tag';
  return now.getTime() >= from ? 'code' : 'tag';
}

// ── Starting ──

export type StartRefusal = 'not_owner' | 'deleted' | 'no_pages' | 'open_transfer' | 'domain_not_ready' | 'unpaid_domain';

export const START_REFUSALS: Record<StartRefusal, string> = {
  not_owner: 'Only the account owner can take the website.',
  deleted: 'This website has been deleted, so there is nothing to take.',
  no_pages: 'This website has no pages yet.',
  open_transfer: 'A transfer for this website is already under way.',
  domain_not_ready: 'Your domain is still being set up; try again once it is live.',
  unpaid_domain: 'Please pay for your domain first, then you can take your website.',
};

export interface CanStartInput {
  /** The signed-in account is the owner of the website (not a team member). */
  isOwner: boolean;
  /** The website has been deleted. A paused site may still be transferred. */
  deleted: boolean;
  /** How many pages the site has. */
  pageCount: number;
  /** The website already has an open (not cancelled, not ended) transfer. */
  hasOpenTransfer: boolean;
  /** The website has a domain of its own (website_domains row), live or not. */
  hasDomain: boolean;
  /** That domain is live (registered and serving). Ignored when hasDomain is false. */
  domainReady: boolean;
  /** The owner has an unpaid row in website_domain_charges, when domain charging is on. */
  domainUnpaid: boolean;
}

export type CanStart = { ok: true } | { ok: false; code: StartRefusal; message: string };

const refuse = (code: StartRefusal): CanStart => ({ ok: false, code, message: START_REFUSALS[code] });

/** First refusal wins, in the order of StartRefusal. No domain at all is fine (files only). */
export function canStart(input: CanStartInput): CanStart {
  if (!input.isOwner) return refuse('not_owner');
  if (input.deleted) return refuse('deleted');
  if (!(input.pageCount > 0)) return refuse('no_pages');
  if (input.hasOpenTransfer) return refuse('open_transfer');
  if (input.hasDomain && !input.domainReady) return refuse('domain_not_ready');
  if (input.domainUnpaid) return refuse('unpaid_domain');
  return { ok: true };
}

// ── Overlap ──

/** When our copy stops serving at the latest: `days` after the transfer started. */
export function overlapEndsAt(start: Date, days: number): Date {
  return new Date(start.getTime() + days * DAY_MS);
}

type When = Date | string | null | undefined;

const ms = (v: When): number | null => {
  if (v === null || v === undefined) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

export interface OverlapRow {
  overlap_ends_at: When;
  domain_state: TransferDomainState | string;
  overlap_ended_at?: When;
  cancelled_at?: When;
  /** Admin clicked "End overlap now". */
  forced?: boolean;
}

/** The overlap is over and our copy should now stop: the date has passed AND (the domain is moved or there is none, or admin forced it), once. */
export function overlapDue(row: OverlapRow, now: Date): boolean {
  if (ms(row.overlap_ended_at) !== null || ms(row.cancelled_at) !== null) return false;
  const ends = ms(row.overlap_ends_at);
  if (ends === null || ends > now.getTime()) return false;
  return row.domain_state === 'none' || row.domain_state === 'moved' || row.forced === true;
}

// ── Stuck ──

export interface StuckRow {
  domain_state: TransferDomainState | string;
  domain_requested_at: When;
  stuck_alerted_at?: When;
  cancelled_at?: When;
}

/** The domain move has sat for more than `days` days since it was requested, and admin has not been told yet. */
export function stuckDue(row: StuckRow, now: Date, days: number): boolean {
  if (row.domain_state === 'moved') return false;
  if (ms(row.cancelled_at) !== null || ms(row.stuck_alerted_at) !== null) return false;
  const asked = ms(row.domain_requested_at);
  if (asked === null) return false;
  return now.getTime() - asked > days * DAY_MS;
}
