/**
 * Batch 33: how the admin's Domains list reads. Pure: the panel draws these
 * words, so what an admin sees about a domain, and why it is where it is,
 * is decided and tested here.
 *
 * No registrar reference, token or response body is ever shown: the last error
 * is a code and an HTTP status (200 characters at most), as stored.
 */
import { daysToExpiry, inRenewalWindow } from './policy.ts';
import { AUTO_RENEW_DAYS, type DomainStatus } from './types.ts';

export function money(pence: number | null | undefined): string {
  if (pence === null || pence === undefined || !Number.isFinite(pence)) return '—';
  const pounds = pence / 100;
  return Number.isInteger(pounds) ? `£${pounds}` : `£${pounds.toFixed(2)}`;
}

/** "Daily spend cap reached: £0 of £0 left" (what is left today of the cap, then the cap). */
export function capLine(capPence: number, usedPence: number): string {
  return `Daily spend cap reached: ${money(Math.max(0, capPence - usedPence))} of ${money(capPence)} left`;
}

export interface WhyFacts {
  status: DomainStatus;
  lastError: string | null;
  attempts: number;
  costPence: number | null;
  autoBuy: boolean;
  capPence: number;
  /** Claimed plus bought pence today (UK day). */
  usedTodayPence: number;
  renewAllowed: boolean;
}

/** Why the domain is in this state, in one sentence, and what (if anything) the admin does. */
export function domainWhy(f: WhyFacts): string {
  const err = f.lastError ? ` (${f.lastError})` : '';
  switch (f.status) {
    case 'awaiting_admin':
      return f.autoBuy ? 'Waiting for the next run.' : 'Auto-buy is off: press Buy to purchase it.';
    case 'held_cap':
      return `${capLine(f.capPence, f.usedTodayPence)}. It is tried again automatically the next UK day.`;
    case 'registering':
      return `A registrar call is in progress or its answer was unclear${err}. It is resumed automatically after checking whether Stayful already owns the name.`;
    case 'connecting':
      return f.lastError?.startsWith('waiting:') ? `Bought. Connecting: ${f.lastError.slice('waiting:'.length).trim()}.` : `Bought. DNS, Vercel and HTTPS are under way${err}.`;
    case 'live':
      return f.lastError === 'email_not_sent' ? 'Live. The member’s "your website is live" email did not go and is tried again.' : f.renewAllowed ? 'Live.' : 'Live. Renewing is switched off for this website.';
    case 'needs_choice':
      return `The name went before it was bought (nothing was spent)${err}. The member picks again.`;
    case 'failed':
      return `Failed after ${f.attempts} tries${err}. Press Retry.`;
    case 'releasing':
      return `Being released${err}. Press Release again to finish.`;
    case 'released':
      return 'Released. Auto-renew is off; Stayful keeps the name until it expires.';
  }
}

export interface DomainListRow {
  id: string;
  name: string;
  status: DomainStatus;
  siteSlug: string | null;
  company: string | null;
  memberEmail: string | null;
  boughtAt: string | null;
  costPence: number | null;
  expiresAt: string | null;
  lastError: string | null;
  why: string;
  /** The buttons that make sense now. */
  actions: AdminKind[];
  /** Days to expiry, for a live domain; null otherwise. */
  daysLeft: number | null;
  renewDecision: 'renew' | 'dont_renew' | null;
  /** On the renewals list: live and within 30 days of expiry. */
  renewalDue: boolean;
}

export type AdminKind = 'buy' | 'retry' | 'release' | 'renew' | 'dont_renew';

/** Which buttons a status offers. Renew and Don't renew only on the renewals list (see renewalDue). */
export function actionsFor(status: DomainStatus): AdminKind[] {
  switch (status) {
    case 'awaiting_admin':
      return ['buy', 'release'];
    case 'held_cap':
    case 'needs_choice':
    case 'connecting':
    case 'live':
      return ['release'];
    case 'failed':
      return ['retry', 'release'];
    case 'releasing':
      return ['release'];
    default:
      return [];
  }
}

export function renewalLine(row: Pick<DomainListRow, 'daysLeft' | 'renewDecision' | 'expiresAt'>): string {
  if (row.daysLeft === null) return '';
  const when = row.daysLeft < 0 ? `expired ${-row.daysLeft} days ago` : `expires in ${row.daysLeft} days`;
  const decided = row.renewDecision === 'renew' ? 'You chose Renew.' : row.renewDecision === 'dont_renew' ? 'You chose Don’t renew.' : row.daysLeft <= AUTO_RENEW_DAYS ? 'No decision: it renews automatically if the website is live.' : `No decision yet; the ${AUTO_RENEW_DAYS}-day rule applies.`;
  return `${when}. ${decided}`;
}

export function buildRow(
  d: { id: string; name: string; status: DomainStatus; boughtAt: string | null; costPence: number | null; expiresAt: string | null; lastError: string | null; attempts: number; renewAllowed: boolean; renewDecision: 'renew' | 'dont_renew' | null },
  site: { slug: string; company: string } | null,
  memberEmail: string | null,
  ctx: { autoBuy: boolean; capPence: number; usedTodayPence: number },
  now: Date = new Date(),
): DomainListRow {
  const left = d.status === 'live' ? daysToExpiry(d.expiresAt, now) : null;
  return {
    id: d.id,
    name: d.name,
    status: d.status,
    siteSlug: site?.slug ?? null,
    company: site?.company ?? null,
    memberEmail,
    boughtAt: d.boughtAt,
    costPence: d.costPence,
    expiresAt: d.expiresAt,
    lastError: d.lastError,
    why: domainWhy({ status: d.status, lastError: d.lastError, attempts: d.attempts, costPence: d.costPence, autoBuy: ctx.autoBuy, capPence: ctx.capPence, usedTodayPence: ctx.usedTodayPence, renewAllowed: d.renewAllowed }),
    actions: actionsFor(d.status),
    daysLeft: left,
    renewDecision: d.renewDecision,
    renewalDue: inRenewalWindow(d.status, d.expiresAt, now),
  };
}
