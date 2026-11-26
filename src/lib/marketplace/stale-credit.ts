/**
 * Deal feed (queue Batch 1): the stale-deal credit. A member who opened a deal that went
 * off the market within deal_stale_credit_days (7) of the open gets back what they actually
 * spent on that deal: the open, plus the full report if they bought one. Pure, so the rule
 * and the amount are tested; the reads and the grant are in stale-credit-server.ts.
 *
 * The amount is read from the ledger's own debit rows, never from the list price, so a
 * free pick, a plan-credit open or a half-refunded open credits exactly what was taken
 * (nothing, when nothing was). It is granted as an 'adjustment' with the source_ref
 * 'stale:<open id>', which the credit ledger keeps unique, so it can only ever happen once.
 */
import type { RetiredReason } from './types.ts';

/** The retirements that mean the listing went: the only ones that earn the credit. */
export const STALE_REASONS: ReadonlySet<RetiredReason> = new Set<RetiredReason>(['sold', 'under_offer', 'let_agreed', 'removed']);

export interface StaleOpen {
  status: string;
  opened_at: string;
  stale_credit_at: string | null;
}

export interface StaleDeal {
  status: string;
  retired_reason: string | null;
  retired_at: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The ledger source_ref that makes the grant once-only. */
export function staleSourceRef(openId: string): string {
  return `stale:${openId}`;
}

/** Why a deal is or is not due, so the admin button can say it in words. */
export type StaleVerdict = 'due' | 'not_open' | 'already_credited' | 'not_retired' | 'not_a_gone_reason' | 'outside_window' | 'bad_dates';

export function staleVerdict(open: StaleOpen, deal: StaleDeal, settings: { staleCreditDays: number }, opts: { ignoreWindow?: boolean } = {}): StaleVerdict {
  if (open.status !== 'open') return 'not_open';
  if (open.stale_credit_at !== null) return 'already_credited';
  if (deal.status !== 'retired') return 'not_retired';
  if (!deal.retired_reason || !STALE_REASONS.has(deal.retired_reason as RetiredReason)) return 'not_a_gone_reason';
  const opened = Date.parse(open.opened_at);
  const retired = deal.retired_at ? Date.parse(deal.retired_at) : Number.NaN;
  if (!Number.isFinite(opened) || !Number.isFinite(retired)) return 'bad_dates';
  if (!opts.ignoreWindow && (retired < opened || retired - opened > settings.staleCreditDays * DAY_MS)) return 'outside_window';
  return 'due';
}

/** True when the credit is due now (open, not yet credited, the deal gone for a real reason inside the window). */
export function staleCreditDue(open: StaleOpen, deal: StaleDeal, settings: { staleCreditDays: number }, opts: { ignoreWindow?: boolean } = {}): boolean {
  return staleVerdict(open, deal, settings, opts) === 'due';
}

export interface LedgerRow {
  id: number | string;
  user_id: string;
  kind: string;
  amount_pence: number | string | null;
  metadata?: { refund_of?: unknown } | null;
}

const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/**
 * What the member really spent on the deal: the debits named in `debitIds` (the open's
 * transaction and the transactions of their completed analysis purchases) that were taken
 * from `userId`, less any refunds already made against those debits. Never below zero.
 * Amounts are the displayed pence the ledger moved (the number on their usage page).
 */
export function stalePence(ledger: readonly LedgerRow[], debitIds: readonly (number | string)[], userId: string): number {
  const wanted = new Set(debitIds.map(String));
  const counted = new Set<string>();
  let spent = 0;
  for (const r of ledger) {
    if (r.kind !== 'debit' || r.user_id !== userId || !wanted.has(String(r.id)) || counted.has(String(r.id))) continue;
    const amount = Math.abs(Number(r.amount_pence) || 0);
    if (amount <= 0) continue;
    counted.add(String(r.id));
    spent += amount;
  }
  let refunded = 0;
  for (const r of ledger) {
    if (r.kind !== 'refund' || r.user_id !== userId) continue;
    const of = r.metadata?.refund_of;
    if (of === undefined || of === null || !counted.has(String(of))) continue;
    refunded += Math.abs(Number(r.amount_pence) || 0);
  }
  return Math.max(0, round4(spent - refunded));
}

/**
 * The purchases that count: those started before the deal went. A full report bought on a deal
 * that was already gone was bought knowing it, so it is not credited back. A purchase with no
 * usable date is left out (never credit what cannot be dated).
 */
export function purchasesBeforeGone<T extends { created_at: string | null }>(purchases: readonly T[], retiredAt: string | null): T[] {
  const gone = retiredAt ? Date.parse(retiredAt) : Number.NaN;
  if (!Number.isFinite(gone)) return [];
  return purchases.filter((p) => {
    const at = p.created_at ? Date.parse(p.created_at) : Number.NaN;
    return Number.isFinite(at) && at <= gone;
  });
}

/** "Gone within 7 days, £1.00 credited back". */
export function staleCreditLine(days: number, pence: number): string {
  const pounds = pence / 100;
  const money = Number.isInteger(pence) && pence % 100 === 0 ? `£${pounds.toFixed(0)}` : `£${pounds.toFixed(2)}`;
  return `Gone within ${days} days, ${money} credited back`;
}

// ── Settling one open (the grant and the stamp), with its reads and writes passed in so it is tested without a database ──

export interface StaleOpenFacts extends StaleOpen {
  id: string;
  user_id: string;
}

export interface StaleDeps {
  /** What the member was actually debited for this open and its completed reports, net of refunds (stalePence over the ledger). */
  spentPence(open: StaleOpenFacts): Promise<number>;
  /** The credit ledger's grant: idempotent on `sourceRef`. */
  grant(userId: string, pence: number, sourceRef: string, description: string): Promise<void>;
  /** Marks the open settled (only while it is not already); false on a write error. */
  stamp(openId: string, pence: number, atIso: string): Promise<boolean>;
}

export type StaleGrantOutcome =
  | { ok: true; pence: number; granted: boolean }
  | { ok: false; code: StaleVerdict | 'failed' | 'missing' };

/** Whether a run does anything: nothing while the switch is off, except a dry run, which only lists. */
export function staleRunMode(settings: { staleCreditEnabled: boolean }, dry: boolean): 'skip' | 'dry' | 'live' {
  if (dry) return 'dry';
  return settings.staleCreditEnabled ? 'live' : 'skip';
}

/**
 * Credits one open if it is due. A dry run works out the amount and writes nothing. A free
 * open (nothing taken from the balance) is settled at 0 and nothing is granted.
 */
export async function settleStale(deps: StaleDeps, open: StaleOpenFacts, deal: StaleDeal, settings: { staleCreditDays: number }, opts: { ignoreWindow?: boolean; dry?: boolean; now?: Date } = {}): Promise<StaleGrantOutcome> {
  const verdict = staleVerdict(open, deal, settings, { ignoreWindow: opts.ignoreWindow });
  if (verdict !== 'due') return { ok: false, code: verdict };
  let pence: number;
  try {
    pence = await deps.spentPence(open);
  } catch {
    return { ok: false, code: 'failed' };
  }
  if (opts.dry) return { ok: true, pence, granted: false };
  let granted = false;
  if (pence > 0) {
    try {
      await deps.grant(open.user_id, pence, staleSourceRef(open.id), `Deal went off the market within ${settings.staleCreditDays} days`);
      granted = true;
    } catch {
      return { ok: false, code: 'failed' };
    }
  }
  // Settled either way, so the cron never reads it again. If this write fails the next run grants again, which the ledger's source_ref makes a no-op.
  if (!(await deps.stamp(open.id, pence, (opts.now ?? new Date()).toISOString()))) return { ok: false, code: 'failed' };
  return { ok: true, pence, granted };
}
