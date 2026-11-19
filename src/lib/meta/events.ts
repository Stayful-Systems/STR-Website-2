/**
 * The conversions Meta is told about, and the rules for each. Every
 * decision about "does this count, and as what" is here and tested; the
 * server code only looks things up and records.
 *
 *   CompleteRegistration  a website account (email or Google) is first signed
 *                         in. Not lead-form accounts (the n8n lead workflow
 *                         reports those), not team seats. Once per account.
 *   ProfileComplete       the profile quiz is first complete. Once per account.
 *   FirstReport           the first finished analyser report, Full analysis or
 *                         (Review R4, Zac) £2 buy-to-let report. Once per
 *                         account, whichever comes first.
 *   Subscribe             the first paid invoice (amount > 0) of a subscription
 *                         started after tracking began. Once per member.
 *   Purchase              Batch 29: the £10 starter pack only, at its price
 *                         excluding VAT. Once per member; a repeat pack that
 *                         was charged anyway (blocked) is never one.
 *   RepeatPurchase        Batch 29 (custom): a pack buyer's FIRST payment
 *                         after the pack: a top-up they chose, an automatic
 *                         top-up, or a plan's first paid invoice. Once per
 *                         member, excluding VAT, from the server (CAPI) and
 *                         the browser with the same id. Later payments send
 *                         nothing new; a member who never bought the pack
 *                         never sends one. Chosen top-ups no longer send
 *                         Purchase.
 *
 * Batch 22f, management companies (custom events, so their ads optimise for
 * a lead form going live rather than an investor sign-up). Once per account:
 *   mc_signup             an account is stamped as a management company
 *   mc_pack_paid          a management company's starter pack is paid
 *   funnel_live           an owner's first lead form goes live
 *
 * The first three only count for accounts created after tracking began
 * (billing_settings.meta_tracking_since), so existing members never fire them;
 * RepeatPurchase only for a pack bought after it.
 * Values are in GBP, excluding VAT. Pure: no network, no database, no server-only.
 */
import { EVENT_SOURCE_PATHS } from '../tracking/config.ts';

export const META_EVENTS = ['CompleteRegistration', 'ProfileComplete', 'FirstReport', 'Subscribe', 'Purchase', 'RepeatPurchase', 'mc_signup', 'mc_pack_paid', 'funnel_live'] as const;
export type MetaEventName = (typeof META_EVENTS)[number];

/** Meta's own names are sent with fbq('track'); ours with fbq('trackCustom'). */
const CUSTOM: ReadonlySet<MetaEventName> = new Set<MetaEventName>(['ProfileComplete', 'FirstReport', 'RepeatPurchase', 'mc_signup', 'mc_pack_paid', 'funnel_live']);

export function isMetaEvent(v: unknown): v is MetaEventName {
  return typeof v === 'string' && (META_EVENTS as readonly string[]).includes(v);
}

export function isCustomEvent(name: MetaEventName): boolean {
  return CUSTOM.has(name);
}

/** Only the payments carry a value. */
export function carriesValue(name: MetaEventName): boolean {
  return name === 'Subscribe' || name === 'Purchase' || name === 'RepeatPurchase';
}

/**
 * The one key that makes each conversion happen once: per account, every
 * one of them (Batch 29: Purchase is the pack, once per member, and
 * RepeatPurchase the first payment after it). Purchase rows recorded before
 * Batch 29 were keyed per PaymentIntent ('Purchase:pi_…') and stay as they were.
 */
export function dedupeKeyFor(name: MetaEventName, ids: { userId: string }): string | null {
  if (!ids.userId) return null;
  return `${name}:${ids.userId}`;
}

/** The page a server event is reported against: always the site's own address, never a query string. */
export function eventSourceUrl(name: MetaEventName, siteBase: string): string {
  return `${siteBase.replace(/\/+$/, '')}${EVENT_SOURCE_PATHS[name]}`;
}

/** Pence to Meta's value (pounds, two places). */
export function penceToValue(pence: number): number {
  return Math.round(pence) / 100;
}

/** An account created at or after tracking began (the three journey events only count for these). */
export function isPostLaunch(createdAt: string | Date | null | undefined, trackingSince: string | Date | null | undefined): boolean {
  if (!createdAt || !trackingSince) return false;
  const c = new Date(createdAt).getTime();
  const t = new Date(trackingSince).getTime();
  return Number.isFinite(c) && Number.isFinite(t) && c >= t;
}

/** What the webhook knows about a paid subscription invoice. */
export interface InvoiceFacts {
  amountPaid: number | null | undefined;
  totalExcludingTax: number | null | undefined;
  billingReason: string | null | undefined;
  currency: string | null | undefined;
  /** When the subscription itself started (its start_date). */
  subscriptionStartedAt: string | Date | null | undefined;
}

/**
 * Whether a paid subscription invoice is a Subscribe, and its value in pence
 * (excluding VAT). A plan change's proration invoice never is; a £0 invoice
 * (a 100%-off first month) never is, so the first invoice actually paid is
 * the one that counts; a subscription started before tracking began never is,
 * so existing subscribers' renewals never fire. "The first" is the caller's
 * once-per-member key.
 */
export function subscribeFromInvoice(inv: InvoiceFacts, trackingSince: string | Date | null | undefined): { valuePence: number; currency: 'GBP' } | null {
  const v = invoiceValue(inv);
  if (!v) return null;
  if (!isPostLaunch(inv.subscriptionStartedAt ?? null, trackingSince)) return null;
  return v;
}

/** A paid plan invoice's value excluding VAT: a first or renewal invoice actually paid in GBP (never a plan change's proration). */
export function invoiceValue(inv: InvoiceFacts): { valuePence: number; currency: 'GBP' } | null {
  const paid = Number(inv.amountPaid ?? 0);
  if (!Number.isFinite(paid) || paid <= 0) return null;
  if ((inv.currency ?? 'gbp').toLowerCase() !== 'gbp') return null;
  const reason = inv.billingReason ?? null;
  if (reason !== null && reason !== 'subscription_create' && reason !== 'subscription_cycle' && reason !== 'manual') return null;
  const exVat = Number(inv.totalExcludingTax);
  const valuePence = Number.isFinite(exVat) && exVat > 0 ? Math.min(exVat, paid) : paid;
  return { valuePence: Math.round(valuePence), currency: 'GBP' };
}

/** What a top-up PaymentIntent carries. */
export interface TopupFacts {
  /** metadata.kind: only 'topup' is a credit top-up. */
  kind: string | null | undefined;
  /** metadata.auto: '1' for an automatic top-up (a RepeatPurchase all the same). */
  auto: string | null | undefined;
  /** metadata.amount_pence: the credit bought, excluding VAT. */
  amountPence: string | number | null | undefined;
  currency: string | null | undefined;
}

/** A paid top-up's value in pence (the credit bought, excluding VAT), chosen or automatic. */
export function topupValue(t: TopupFacts): { valuePence: number; currency: 'GBP' } | null {
  if (t.kind !== 'topup') return null;
  if ((t.currency ?? 'gbp').toLowerCase() !== 'gbp') return null;
  const pence = Number(t.amountPence);
  if (!Number.isFinite(pence) || pence <= 0) return null;
  return { valuePence: Math.round(pence), currency: 'GBP' };
}

/** What a captured starter pack carries. */
export interface PackFacts {
  /** The pack's price, excluding VAT (metadata.price_pence). */
  pricePence: string | number | null | undefined;
  currency: string | null | undefined;
  /** grantStarterPack's answer: a repeat charged anyway ('blocked') is never a Purchase. */
  outcome?: 'granted' | 'already' | 'blocked' | 'ignored' | null;
}

/** Batch 29: the pack is the Purchase, at its price excluding VAT. Never a blocked repeat. */
export function purchaseFromPack(p: PackFacts): { valuePence: number; currency: 'GBP' } | null {
  if (p.outcome === 'blocked' || p.outcome === 'ignored') return null;
  if ((p.currency ?? 'gbp').toLowerCase() !== 'gbp') return null;
  const pence = Number(p.pricePence);
  if (!Number.isFinite(pence) || pence <= 0) return null;
  return { valuePence: Math.round(pence), currency: 'GBP' };
}

/** A payment that may be a pack buyer's RepeatPurchase. */
export interface RepeatFacts {
  /** This payment's member_payments id: 'pi:<PaymentIntent>' for a top-up, 'inv:<invoice>' for a plan. */
  paymentId: string;
  topup?: TopupFacts;
  invoice?: InvoiceFacts;
}

/** The payment's value excluding VAT, when it is the kind that can be a RepeatPurchase. */
export function repeatValue(r: RepeatFacts): { valuePence: number; currency: 'GBP' } | null {
  if (!r.paymentId) return null;
  if (r.topup) return topupValue(r.topup);
  if (r.invoice) return invoiceValue(r.invoice);
  return null;
}

/**
 * Batch 29: whether this payment is the pack buyer's first after the pack.
 * `packAt` is when their pack was granted (null: they never bought one, so
 * nothing: Zac, question 10); `earlierFurtherPayment` whether a top-up or plan
 * payment other than this one has landed since the pack. A pack bought before
 * tracking began never counts.
 */
export function repeatPurchaseDue(f: { packAt: string | Date | null | undefined; trackingSince: string | Date | null | undefined; earlierFurtherPayment: boolean }): boolean {
  if (!f.packAt) return false;
  if (!isPostLaunch(f.packAt, f.trackingSince)) return false;
  return !f.earlierFurtherPayment;
}

/** The parameters the browser fires a conversion with (value only for the payments). */
export function browserParams(name: MetaEventName, valuePence: number | null | undefined): Record<string, string | number> {
  if (!carriesValue(name) || valuePence === null || valuePence === undefined || !Number.isFinite(valuePence)) return {};
  return { value: penceToValue(valuePence), currency: 'GBP' };
}
