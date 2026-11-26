/**
 * The lead database ad account on this side (Batch 55, Part A): the last state
 * the lead database pushed for an operator (card, status, a cancel date,
 * lapsed) and the rule that decides whether the lead database ad route is
 * stopped for that operator.
 *
 * PURE: no I/O, no Next, no server-only, so it runs under `node --test`. The
 * real database lives in ad-account-server.ts.
 *
 * Rules that must not drift:
 * - Fail closed. No account, or an account that has never received a state
 *   (`stateAsOf` null), is stopped.
 * - PAUSE IS NEVER READ. A paused account (`accountStatus` 'paused') is not
 *   stopped by itself; nor is 'active', 'past_due' (a card is still on file)
 *   or 'pending_cancel' before its date. ASSUMPTION for Zac: past due alone
 *   does not stop the route; the lead database says so by clearing the card,
 *   lapsing or cancelling the account.
 * - An older push never replaces a newer one (`shouldApplyState`).
 */

/** The row in `leaddb_ad_accounts`, as the database returns it. */
export interface LeadDbAdAccountRow {
  owner_id: string;
  ld_customer_id: string;
  link_id: string | null;
  allowed: boolean;
  allowed_by: string | null;
  allowed_at: string | null;
  card_on_file: boolean;
  account_status: string | null;
  cancel_effective_at: string | null;
  lapsed: boolean;
  state_as_of: string | null;
  created_at: string;
  updated_at: string;
}

/** The row, camelCase, with the timestamps the rule reads as Dates. */
export interface LeadDbAdAccount {
  ownerId: string;
  ldCustomerId: string;
  linkId: string | null;
  allowed: boolean;
  cardOnFile: boolean;
  accountStatus: string | null;
  cancelEffectiveAt: Date | null;
  lapsed: boolean;
  /** When the lead database said this state was true. Null: no state has ever arrived. */
  stateAsOf: Date | null;
}

/** The signed state the lead database pushes. Codes and flags only, never a person's details. */
export interface AdAccountState {
  accountStatus: string | null;
  cardOnFile: boolean;
  /** ISO 8601, or null when no cancellation is scheduled. */
  cancelEffectiveAt: string | null;
  lapsed: boolean;
  /** ISO 8601. Required. */
  stateAsOf: string;
}

export type AdRouteStopReason = 'no_account' | 'not_allowed' | 'no_card' | 'account_stopped';
export type AdRouteVerdict = { ok: true } | { ok: false; reason: AdRouteStopReason };

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const MAX_STATUS_LENGTH = 64;

function parseIso(v: unknown): Date | null {
  if (typeof v !== 'string' || !ISO.test(v)) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
}

function toDate(v: string | null): Date | null {
  if (v === null || v === undefined) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
}

/** The database row as the type the rule reads. */
export function rowToAdAccount(row: LeadDbAdAccountRow): LeadDbAdAccount {
  return {
    ownerId: row.owner_id,
    ldCustomerId: row.ld_customer_id,
    linkId: row.link_id ?? null,
    allowed: row.allowed === true,
    cardOnFile: row.card_on_file === true,
    accountStatus: row.account_status ?? null,
    cancelEffectiveAt: toDate(row.cancel_effective_at),
    lapsed: row.lapsed === true,
    stateAsOf: toDate(row.state_as_of),
  };
}

/** The columns a state writes. Never allowed, allowed_by or allowed_at: those are Zac's. */
export function stateToRowPatch(state: AdAccountState): {
  account_status: string | null;
  card_on_file: boolean;
  cancel_effective_at: string | null;
  lapsed: boolean;
  state_as_of: string;
} {
  return {
    account_status: state.accountStatus,
    card_on_file: state.cardOnFile,
    cancel_effective_at: state.cancelEffectiveAt,
    lapsed: state.lapsed,
    state_as_of: state.stateAsOf,
  };
}

/**
 * Strict check of a pushed state. Never throws; null when anything is off.
 * `cardOnFile`, `lapsed` and `stateAsOf` are required; `accountStatus` and
 * `cancelEffectiveAt` may be absent or null.
 */
export function parseAdAccountState(raw: unknown): AdAccountState | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.cardOnFile !== 'boolean' || typeof r.lapsed !== 'boolean') return null;

  let accountStatus: string | null = null;
  if (r.accountStatus !== undefined && r.accountStatus !== null) {
    if (typeof r.accountStatus !== 'string') return null;
    const s = r.accountStatus.trim();
    if (s.length === 0 || s.length > MAX_STATUS_LENGTH) return null;
    accountStatus = s;
  }

  let cancelEffectiveAt: string | null = null;
  if (r.cancelEffectiveAt !== undefined && r.cancelEffectiveAt !== null) {
    if (parseIso(r.cancelEffectiveAt) === null) return null;
    cancelEffectiveAt = r.cancelEffectiveAt as string;
  }

  if (parseIso(r.stateAsOf) === null) return null;
  return { accountStatus, cardOnFile: r.cardOnFile, cancelEffectiveAt, lapsed: r.lapsed, stateAsOf: r.stateAsOf as string };
}

/**
 * Stopped for any reason other than the card: no account, no state yet,
 * lapsed, cancelled, or a cancel date that has arrived. Pause is not read.
 */
function accountStopped(account: LeadDbAdAccount | null, now: Date): boolean {
  if (!account) return true;
  if (account.stateAsOf === null) return true;
  if (account.lapsed) return true;
  const status = account.accountStatus?.trim().toLowerCase() ?? null;
  if (status === 'cancelled' || status === 'lapsed') return true;
  if (account.cancelEffectiveAt && now.getTime() >= account.cancelEffectiveAt.getTime()) return true;
  return false;
}

/**
 * True when the lead database ad route must stop for this account: no
 * account, never received a state, lapsed, cancelled, a cancel date that has
 * arrived, or no card on file. Never reads pause.
 */
export function adRouteStopped(account: LeadDbAdAccount | null, now: Date): boolean {
  if (accountStopped(account, now)) return true;
  return account!.cardOnFile !== true;
}

/**
 * Whether the route may run, and if not, why. Also requires Zac's `allowed`.
 *
 * Order of reasons (the first that applies wins; A7 maps them to the
 * eligibility reasons no_leaddb_account, account_stopped, no_card, not_allowed):
 *   1. no_account       there is no row
 *   2. account_stopped  never received a state, lapsed, cancelled, or past its cancel date
 *   3. no_card          the lead database says no card is on file
 *   4. not_allowed      Zac has not allowed this owner
 */
export function adRouteVerdict(account: LeadDbAdAccount | null, now: Date): AdRouteVerdict {
  if (!account) return { ok: false, reason: 'no_account' };
  if (accountStopped(account, now)) return { ok: false, reason: 'account_stopped' };
  if (account.cardOnFile !== true) return { ok: false, reason: 'no_card' };
  if (account.allowed !== true) return { ok: false, reason: 'not_allowed' };
  return { ok: true };
}

/**
 * An older push never replaces a newer one. An equal time is applied (a
 * re-send is idempotent). No current row, or one that has never had a state,
 * takes anything.
 */
export function shouldApplyState(current: { stateAsOf: Date | null } | null, incoming: AdAccountState): boolean {
  if (!current || current.stateAsOf === null) return true;
  const incomingAt = Date.parse(incoming.stateAsOf);
  if (Number.isNaN(incomingAt)) return false;
  return incomingAt >= current.stateAsOf.getTime();
}
