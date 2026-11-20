import { adminClient, hasServiceRole } from './db.ts';
import type { Buckets, SpendRates } from './pricing.ts';
import { round4 } from './pricing.ts';
import { getBillingSettings } from './unit-costs.ts';

/**
 * Thin wrappers over the credit_* Postgres functions (service role). Every
 * mutation is atomic inside the database; this layer only maps errors and
 * shapes results. Without a service role (local dev without Supabase, unit
 * tests) reads return an empty balance and writes are no-ops, so the app
 * still runs — just without billing.
 */

export class InsufficientCreditError extends Error {
  readonly code = 'insufficient_credit';
  readonly requiredPence: number;
  readonly availablePence: number;
  constructor(requiredPence: number, availablePence: number) {
    super('insufficient_credit');
    this.requiredPence = requiredPence;
    this.availablePence = availablePence;
  }
}

export type GrantKind = 'plan' | 'welcome' | 'topup' | 'adjustment';

export interface Balance {
  buckets: Buckets;
  /** Grant pence across every unexpired bucket (what the member sees). */
  totalPence: number;
  /** Base pence the buckets cover after open reservations. */
  spendableBasePence: number;
  reservedBasePence: number;
  planExpiresAt: string | null;
  rates: SpendRates;
}

export const EMPTY_BALANCE: Balance = {
  buckets: { planPence: 0, welcomePence: 0, topupPence: 0, adjustmentPence: 0 },
  totalPence: 0,
  spendableBasePence: 0,
  reservedBasePence: 0,
  planExpiresAt: null,
  rates: { plan: 1, welcome: 1, topup: 1.3, adjustment: 1.3 },
};

interface RpcError {
  code?: string;
  message?: string;
  details?: string | null;
}

function toInsufficient(err: RpcError): InsufficientCreditError | null {
  if (err.code !== 'P0402' && err.message !== 'insufficient_credit') return null;
  let required = 0;
  let available = 0;
  try {
    const d = JSON.parse(err.details ?? '{}') as Record<string, unknown>;
    if (d.required_face !== undefined) {
      // credit_debit_face reports displayed pence, not base.
      required = Number(d.required_face) || 0;
      available = Number(d.available_face ?? (Number(d.required_face) - Number(d.shortfall_face ?? 0))) || 0;
    } else {
      required = Number(d.required_base ?? 0) || 0;
      available = Number(d.spendable_base ?? (Number(d.required_base ?? 0) - Number(d.shortfall_base ?? 0))) || 0;
    }
  } catch {
    /* no detail */
  }
  return new InsufficientCreditError(required, available);
}

function throwRpc(err: RpcError, what: string): never {
  const ins = toInsufficient(err);
  if (ins) throw ins;
  throw new Error(`[credit] ${what} failed: ${err.message ?? 'unknown error'}`);
}

export async function getBalance(userId: string): Promise<Balance> {
  if (!hasServiceRole()) return EMPTY_BALANCE;
  const [{ data, error }, settings] = await Promise.all([(await adminClient()).rpc('credit_available', { p_user: userId }), getBillingSettings()]);
  if (error) throwRpc(error, 'credit_available');
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  const n = (k: string) => round4(Number(row?.[k] ?? 0) || 0);
  const buckets: Buckets = { planPence: n('plan_pence'), welcomePence: n('welcome_pence'), topupPence: n('topup_pence'), adjustmentPence: n('adjustment_pence') };
  return {
    buckets,
    totalPence: round4(buckets.planPence + buckets.welcomePence + buckets.topupPence + buckets.adjustmentPence),
    spendableBasePence: n('spendable_base_pence'),
    reservedBasePence: n('reserved_base_pence'),
    planExpiresAt: (row?.plan_expires_at as string | null) ?? null,
    rates: settings.spendRates,
  };
}

/**
 * Batch 29: base pence THIS action may spend (public.credit_spendable_for). The
 * starter pack's restricted bonus counts only for the actions it pays for
 * (src/lib/credit/pack-rules.ts); for those this equals getBalance's
 * spendableBasePence. Use it for "can they afford it" before charging.
 */
export async function spendableFor(userId: string, action: string, meta: Record<string, unknown> = {}): Promise<number> {
  if (!hasServiceRole()) return 0;
  const { data, error } = await (await adminClient()).rpc('credit_spendable_for', { p_user: userId, p_action: action, p_meta: meta });
  if (error) throwRpc(error, 'credit_spendable_for');
  return round4(Number(data ?? 0) || 0);
}

/**
 * Batch 29: the balance as one action sees it, for callers that size a face
 * charge (calls, texts): the displayed pence and spendable base it may use
 * (never the starter pack's restricted bonus unless the action is one it pays
 * for), and what open reservations hold. Shaped for voice/charge.ts callablePence.
 */
export async function balanceFor(userId: string, action: string): Promise<{ totalPence: number; spendableBasePence: number; reservedBasePence: number; rates: SpendRates }> {
  const [balance, face, spendable] = await Promise.all([getBalance(userId), faceAvailableFor(userId, action), spendableFor(userId, action)]);
  return { totalPence: face, spendableBasePence: spendable, reservedBasePence: balance.reservedBasePence, rates: balance.rates };
}

/** Batch 29: displayed pence a face debit for this action may take (credit_face_available_for), before open reservations. */
export async function faceAvailableFor(userId: string, action: string): Promise<number> {
  if (!hasServiceRole()) return 0;
  const { data, error } = await (await adminClient()).rpc('credit_face_available_for', { p_user: userId, p_action: action });
  if (error) throwRpc(error, 'credit_face_available_for');
  return round4(Number(data ?? 0) || 0);
}

/**
 * Batch 29: the starter pack's bonus, marked as restricted credit with its
 * expiry, in one transaction (public.credit_grant_pack_bonus). Idempotent on
 * sourceRef, as grant() is.
 */
export async function grantPackBonus(userId: string, amountPence: number, opts: { sourceRef: string; description?: string | null }): Promise<string | null> {
  if (!hasServiceRole()) return null;
  const { data, error } = await (await adminClient()).rpc('credit_grant_pack_bonus', {
    p: { user: userId, amount: round4(amountPence), source_ref: opts.sourceRef, description: opts.description ?? null },
  });
  if (error) throwRpc(error, 'credit_grant_pack_bonus');
  return (data as string | null) ?? null;
}

export async function reserve(userId: string, action: string, actionId: string, maxBasePence: number, ttlMinutes = 10): Promise<string | null> {
  if (!hasServiceRole()) return null;
  if (maxBasePence <= 0) return null;
  const { data, error } = await (await adminClient()).rpc('credit_reserve', { p_user: userId, p_action: action, p_action_id: actionId, p_max_base: round4(maxBasePence), p_ttl: `${ttlMinutes} minutes` });
  if (error) throwRpc(error, 'credit_reserve');
  return (data as string | null) ?? null;
}

export async function release(reservationId: string | null | undefined): Promise<void> {
  if (!reservationId || !hasServiceRole()) return;
  const { error } = await (await adminClient()).rpc('credit_release', { p_reservation: reservationId });
  if (error) console.error('[credit] credit_release failed:', error.message);
}

export interface DebitMeta {
  action_id?: string | null;
  action?: string | null;
  provider?: string;
  unit?: string;
  quantity?: number;
  unit_cost_pence?: number;
  markup?: number;
  raw_cost_pence?: number;
  description?: string;
  provider_call_id?: number | null;
  [k: string]: unknown;
}

export async function debit(userId: string, basePence: number, opts: { reservationId?: string | null; allowNegative?: boolean; meta?: DebitMeta } = {}): Promise<number | null> {
  if (!hasServiceRole() || basePence <= 0) return null;
  const { data, error } = await (await adminClient()).rpc('credit_debit', {
    p_user: userId,
    p_base_pence: round4(basePence),
    p_reservation: opts.reservationId ?? null,
    p_allow_negative: opts.allowNegative ?? false,
    p_meta: opts.meta ?? {},
  });
  if (error) throwRpc(error, 'credit_debit');
  return (data as number | null) ?? null;
}

/**
 * Debits exactly `facePence` of DISPLAYED balance, whichever grants pay it —
 * for flat prices like a £10 team seat. `debit` takes base pence and applies
 * each grant's spend rate, so the same "£10" would cost £15 of top-up credit.
 * Never overdrafts; throws InsufficientCreditError when the balance is short.
 */
export async function debitFace(userId: string, facePence: number, meta: DebitMeta = {}): Promise<number | null> {
  if (!hasServiceRole() || facePence <= 0) return null;
  const { data, error } = await (await adminClient()).rpc('credit_debit_face', {
    p_user: userId,
    p_face_pence: round4(facePence),
    p_meta: meta,
  });
  if (error) throwRpc(error, 'credit_debit_face');
  return (data as number | null) ?? null;
}

export async function refund(transactionId: number, basePence?: number, reason?: string): Promise<number | null> {
  if (!hasServiceRole()) return null;
  const { data, error } = await (await adminClient()).rpc('credit_refund', { p_transaction_id: transactionId, p_base_pence: basePence ?? null, p_reason: reason ?? null });
  if (error) throwRpc(error, 'credit_refund');
  return (data as number | null) ?? null;
}

/**
 * Batch 34 (plan credit rollover): plan credit never expires by date, so a
 * plan grant is always made without an expiry, whatever the caller passes.
 */
export async function grant(userId: string, kind: GrantKind, amountPence: number, opts: { expiresAt?: string | Date | null; sourceRef?: string | null; description?: string | null } = {}): Promise<string | null> {
  if (!hasServiceRole()) return null;
  const expires = kind === 'plan' ? null : opts.expiresAt instanceof Date ? opts.expiresAt.toISOString() : (opts.expiresAt ?? null);
  const { data, error } = await (await adminClient()).rpc('credit_grant', {
    p_user: userId,
    p_kind: kind,
    p_amount: round4(amountPence),
    p_expires_at: expires,
    p_source_ref: opts.sourceRef ?? null,
    p_description: opts.description ?? null,
  });
  if (error) throwRpc(error, 'credit_grant');
  return (data as string | null) ?? null;
}

export async function expirePlanGrants(userId: string, reason: string): Promise<number> {
  if (!hasServiceRole()) return 0;
  const { data, error } = await (await adminClient()).rpc('credit_expire_plan_grants', { p_user: userId, p_reason: reason });
  if (error) throwRpc(error, 'credit_expire_plan_grants');
  return Number(data ?? 0) || 0;
}

/**
 * A new plan cycle in one transaction (Batch 21, B1): under the member's row
 * lock the source_ref is checked and the new grant is made, so a second,
 * concurrent delivery of the same invoice can never grant twice. A replay
 * returns the existing grant with `created: false`. Batch 34: the old plan
 * credit rolls over (nothing is expired, `expired` is always 0) and the new
 * grant has no expiry and is marked plan_cycle (the newest month's credit).
 */
export async function planCycle(
  userId: string,
  amountPence: number,
  opts: { sourceRef: string; description?: string | null },
): Promise<{ grantId: string | null; created: boolean; expired: number }> {
  if (!hasServiceRole()) return { grantId: null, created: false, expired: 0 };
  const { data, error } = await (await adminClient()).rpc('credit_plan_cycle', {
    p_user: userId,
    p_amount: round4(amountPence),
    p_expires_at: null,
    p_source_ref: opts.sourceRef,
    p_description: opts.description ?? null,
  });
  if (error) throwRpc(error, 'credit_plan_cycle');
  const d = (data ?? {}) as { grant_id?: string | null; created?: boolean; expired?: number };
  return { grantId: d.grant_id ?? null, created: Boolean(d.created), expired: Number(d.expired ?? 0) || 0 };
}

/**
 * Batch 34: a LIKE pattern matching `literal` exactly: the LIKE wildcards
 * ('%', '_') and the escape character ('\\') are escaped, so an id with an
 * underscore (every Stripe id) matches only itself.
 */
export function escapeLike(literal: string): string {
  return literal.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Which plan grants to match by source_ref: one exact ref, or every ref starting with a literal prefix. */
export type PlanSourceMatch = { exact: string } | { prefix: string };

/** The LIKE pattern for a match: the literal escaped, and only a prefix match gets the trailing '%'. */
export function planSourcePattern(match: PlanSourceMatch): string {
  if ('exact' in match) {
    if (!match.exact) throw new Error('[credit] planSourcePattern: empty source_ref');
    return escapeLike(match.exact);
  }
  if (!match.prefix) throw new Error('[credit] planSourcePattern: empty prefix');
  return `${escapeLike(match.prefix)}%`;
}

/** Options for expirePlanSource (credit_expire_plan_source's p_total and created-at window). */
export interface PlanSourceOptions {
  /**
   * `maxPence` is the TOTAL to have removed for `reason` from the matched
   * grants: what was already removed for it is subtracted inside the
   * database, under the member's lock (cumulative refunds, redeliveries).
   */
  total?: boolean;
  /** Only grants created at or after this instant (an annual invoice's year). */
  createdFrom?: string | null;
  /** Only grants created before this instant. */
  createdTo?: string | null;
}

/**
 * Batch 34: removes up to `maxPence` (null = all) of the member's unexpired
 * PLAN credit in grants whose source_ref matches, oldest first, never below
 * zero and no other credit touched (credit_expire_plan_source). For a
 * refunded or charged-back plan payment ({ exact: 'inv:<invoice>' }, or an
 * annual plan's { prefix: 'annual:<sub>:' } slots in the invoice's year) and
 * a forfeited Academy trial ({ prefix: 'trial:<sub>:' }).
 */
export async function expirePlanSource(userId: string, match: PlanSourceMatch, maxPence: number | null, reason: string, opts: PlanSourceOptions = {}): Promise<{ expiredPence: number; grants: number }> {
  const pattern = planSourcePattern(match);
  if (!hasServiceRole()) return { expiredPence: 0, grants: 0 };
  if (maxPence !== null && !(maxPence > 0)) return { expiredPence: 0, grants: 0 };
  const { data, error } = await (await adminClient()).rpc('credit_expire_plan_source', {
    p_user: userId,
    p_source_like: pattern,
    p_max_pence: maxPence === null ? null : round4(maxPence),
    p_reason: reason,
    p_total: Boolean(opts.total),
    p_created_from: opts.createdFrom ?? null,
    p_created_to: opts.createdTo ?? null,
  });
  if (error) throwRpc(error, 'credit_expire_plan_source');
  const d = (data ?? {}) as { expired_pence?: number | string; grants?: number | string };
  return { expiredPence: round4(Number(d.expired_pence ?? 0) || 0), grants: Number(d.grants ?? 0) || 0 };
}

export interface IdlePlanRow {
  userId: string;
  lastSpentAt: string | null;
  idleSince: string;
  planRemainingPence: number;
  /** Plan credit in grants older than the newest cycle grant: the newest month never lapses. */
  expirablePence: number;
}

/** Batch 34: members holding plan credit with no spend for plan_credit_idle_months (credit_idle_plan_report; read only). */
export async function idlePlanReport(now: Date = new Date()): Promise<IdlePlanRow[]> {
  if (!hasServiceRole()) return [];
  const { data, error } = await (await adminClient()).rpc('credit_idle_plan_report', { p_now: now.toISOString() });
  if (error) throwRpc(error, 'credit_idle_plan_report');
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    userId: String(r.user_id),
    lastSpentAt: (r.last_spent_at as string | null) ?? null,
    idleSince: String(r.idle_since),
    planRemainingPence: round4(Number(r.plan_remaining_pence ?? 0) || 0),
    expirablePence: round4(Number(r.expirable_pence ?? 0) || 0),
  }));
}

export async function expireDueGrants(): Promise<number> {
  if (!hasServiceRole()) return 0;
  const { data, error } = await (await adminClient()).rpc('credit_expire_due');
  if (error) throwRpc(error, 'credit_expire_due');
  return Number(data ?? 0) || 0;
}

/**
 * Batch 29: what credit_expire_due would do now, writing nothing (the credit
 * sweep's ?dry=1). A starter pack bonus whose member has paid again by its
 * expiry is lifted (never expires); every other due grant with credit left
 * expires.
 */
export async function previewDueGrants(now: Date = new Date()): Promise<{ expire: { user: string; kind: string; scope: string | null; remainingPence: number; expiresAt: string }[]; lift: { user: string; remainingPence: number; expiresAt: string }[] }> {
  const out = { expire: [] as { user: string; kind: string; scope: string | null; remainingPence: number; expiresAt: string }[], lift: [] as { user: string; remainingPence: number; expiresAt: string }[] };
  if (!hasServiceRole()) return out;
  const admin = await adminClient();
  const { data, error } = await admin.from('credit_grants').select('user_id, kind, scope, scope_lifted_at, remaining_pence, expires_at').lte('expires_at', now.toISOString()).gt('remaining_pence', 0).limit(5000);
  if (error) throw new Error(error.message);
  for (const g of (data ?? []) as { user_id: string; kind: string; scope: string | null; scope_lifted_at: string | null; remaining_pence: number; expires_at: string }[]) {
    if (g.scope === 'pack_bonus' && !g.scope_lifted_at) {
      const { data: paidAt, error: paidErr } = await admin.rpc('member_paid_again_at', { p_user: g.user_id });
      if (paidErr) throw new Error(paidErr.message);
      if (typeof paidAt === 'string' && Date.parse(paidAt) <= Date.parse(g.expires_at)) {
        out.lift.push({ user: g.user_id, remainingPence: Number(g.remaining_pence), expiresAt: g.expires_at });
        continue;
      }
    }
    out.expire.push({ user: g.user_id, kind: g.kind, scope: g.scope, remainingPence: Number(g.remaining_pence), expiresAt: g.expires_at });
  }
  return out;
}

export class CodeError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

export async function redeemCode(userId: string, code: string): Promise<{ kind: string; amountPence: number }> {
  if (!hasServiceRole()) throw new CodeError('not_configured');
  const { data, error } = await (await adminClient()).rpc('credit_redeem_code', { p_user: userId, p_code: code });
  if (error) {
    if (error.code === 'P0403') throw new CodeError(error.message || 'code_invalid');
    throwRpc(error, 'credit_redeem_code');
  }
  const d = (data ?? {}) as { kind?: string; amount_pence?: number };
  return { kind: d.kind ?? 'promo', amountPence: Number(d.amount_pence ?? 0) || 0 };
}

/** The debit already on the ledger for this action id (its row and face pence), or null: a charge whose reply was lost is still a charge (R3-26). */
export async function debitFor(actionId: string): Promise<{ id: number; facePence: number } | null> {
  if (!hasServiceRole()) return null;
  const { data } = await (await adminClient()).from('credit_transactions').select('id, amount_pence').eq('action_id', actionId).eq('kind', 'debit').order('id', { ascending: false }).limit(1);
  const row = (data ?? [])[0] as { id: number | string; amount_pence: number | string | null } | undefined;
  return row ? { id: Number(row.id), facePence: Math.abs(Number(row.amount_pence ?? 0) || 0) } : null;
}

/** True when a debit for this action id already exists (once-per-action charges). */
export async function actionAlreadyCharged(actionId: string): Promise<boolean> {
  if (!hasServiceRole()) return false;
  const { data } = await (await adminClient()).from('credit_transactions').select('id').eq('action_id', actionId).eq('kind', 'debit').limit(1);
  return (data?.length ?? 0) > 0;
}
