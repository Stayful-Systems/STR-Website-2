/**
 * Batch 34 (plan credit rollover): the pure sums behind plan credit that
 * follows Stripe money. No network, no database, no server-only, so they run
 * under node --test (plan-credit.test.ts); grants.ts and webhook.ts use them.
 */

/** One plan grant as the upgrade sum reads it (credit_grants). */
export interface PlanGrantRow {
  amount_pence: number | string;
  created_at: string;
  /** A renewal (cycle) grant: monthly, annual-slot or Academy-trial plan credit. */
  plan_cycle?: boolean | null;
  source_ref?: string | null;
}

/** The source_ref of a won dispute's restored plan credit: it is not credit granted for a cycle. */
export function disputeWonRef(invoiceId: string): string {
  return `inv:${invoiceId}:dispute_won`;
}

/**
 * This cycle's plan grants: the newest plan_cycle grant and every plan grant
 * made after it (an upgrade's top-up), oldest first. Banked credit from
 * earlier cycles is not in it, nor a won dispute's restored credit. Empty
 * when no grant is marked as a cycle grant.
 */
export function thisCycleGrants<T extends PlanGrantRow>(rows: readonly T[]): T[] {
  const sorted = [...rows].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  let start = -1;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].plan_cycle) {
      start = i;
      break;
    }
  }
  if (start < 0) return [];
  return sorted.slice(start).filter((r) => !String(r.source_ref ?? '').endsWith(':dispute_won'));
}

/**
 * A mid-cycle upgrade's top-up: the new plan's credit less what THIS cycle
 * already granted (never below 0). `cycle` is thisCycleGrants' answer; with
 * none, `fallbackAlreadyPence` (the old plan's credit) stands in for it.
 */
export function upgradeTopUpPence(newPlanCreditPence: number, cycle: readonly PlanGrantRow[], fallbackAlreadyPence = 0): number {
  const already = cycle.length > 0 ? cycle.reduce((sum, r) => sum + (Number(r.amount_pence) || 0), 0) : fallbackAlreadyPence;
  return Math.max(0, Math.round((Number(newPlanCreditPence) || 0) - already));
}

/**
 * The share of a payment's credit that a refund or dispute of it covers:
 * credit × taken ÷ charged, the taken part capped at the charge (so with VAT
 * on the charge but not the credit the same SHARE comes back, never more
 * than was granted). 0 for anything odd.
 */
export function refundedShare(creditPence: number, takenPence: number, chargedPence: number): number {
  const credit = Math.max(0, Number(creditPence) || 0);
  const taken = Math.max(0, Number(takenPence) || 0);
  const charged = Number(chargedPence) || 0;
  if (credit <= 0 || taken <= 0) return 0;
  if (charged <= 0) return 0;
  return Math.round((credit * Math.min(taken, charged)) / charged);
}

/** An annual plan invoice's credit: its subscription's `annual:<sub>:<YYYY-MM>` slot grants made in the invoice's year [from, to). */
export interface AnnualInvoiceYear {
  subscriptionId: string;
  /** ISO instant: the invoice line's period start. */
  from: string;
  /** ISO instant: the invoice line's period end. */
  to: string;
}

/** The invoice fields annualInvoiceYear reads (a Stripe.Invoice fits). */
export interface AnnualInvoiceLike {
  billing_reason?: string | null;
  parent?: { subscription_details?: { subscription?: string | { id: string } | null } | null } | null;
  lines?: { data?: Array<{ period?: { start?: number | null; end?: number | null } | null }> | null } | null;
}

/**
 * Whether a plan invoice paid for an annual plan's monthly slots, and which
 * year: an annual plan's create, cycle or manual invoice (as invoice.paid
 * grants `annual:<sub>:<YYYY-MM>` for them, not `inv:<id>`). The year is the
 * invoice line's period, so a refund of year 2 never touches year 1's slots.
 * Null for anything else (a monthly plan, an upgrade's proration invoice,
 * which grants under `inv:<id>`, or a line without a period).
 */
export function annualInvoiceYear(invoice: AnnualInvoiceLike | null | undefined, planCode: string | null | undefined): AnnualInvoiceYear | null {
  if (!invoice || planCode !== 'pro_annual') return null;
  const reason = invoice.billing_reason ?? null;
  if (reason !== null && reason !== 'subscription_create' && reason !== 'subscription_cycle' && reason !== 'manual') return null;
  const sub = invoice.parent?.subscription_details?.subscription;
  const subscriptionId = typeof sub === 'string' ? sub : (sub?.id ?? null);
  const period = invoice.lines?.data?.find((l) => Number(l?.period?.start) > 0 && Number(l?.period?.end) > 0)?.period;
  if (!subscriptionId || !period) return null;
  const from = Number(period.start) * 1000;
  const to = Number(period.end) * 1000;
  if (!(to > from)) return null;
  return { subscriptionId, from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/** The plan grants a plan invoice's payment bought: its `inv:<id>` grant, or an annual invoice's slot grants made in its year. */
export interface PlanInvoiceScope {
  match: { exact: string } | { prefix: string };
  createdFrom: string | null;
  createdTo: string | null;
}

export function planInvoiceScope(invoiceId: string, annual?: AnnualInvoiceYear | null): PlanInvoiceScope {
  if (annual) return { match: { prefix: `annual:${annual.subscriptionId}:` }, createdFrom: annual.from, createdTo: annual.to };
  return { match: { exact: `inv:${invoiceId}` }, createdFrom: null, createdTo: null };
}

/** What is still to remove: the share due less what was already removed for the same reason (a redelivery or a cumulative partial refund). */
export function clawbackDue(sharePence: number, alreadyRemovedPence: number): number {
  return Math.max(0, Math.round((Number(sharePence) || 0) - Math.max(0, Number(alreadyRemovedPence) || 0)));
}

/**
 * Whether an Academy trial subscription that has ended ever reached a paid
 * month. Ended on or before its trial end: never (the first paid invoice is
 * at the trial end). Otherwise `paidInvoice` says (null: could not tell, so
 * the credit is kept).
 */
export function trialEndedUnpaid(sub: { trial_end?: number | null; ended_at?: number | null; canceled_at?: number | null }, now: Date, paidInvoice: boolean | null): boolean {
  const trialEnd = Number(sub.trial_end) || 0;
  const endedAt = Number(sub.ended_at) || Number(sub.canceled_at) || Math.floor(now.getTime() / 1000);
  if (trialEnd > 0 && endedAt <= trialEnd) return true;
  return paidInvoice === false;
}
