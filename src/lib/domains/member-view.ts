/**
 * Batch 33: what the member sees about their web address, as a pure
 * function of the site's status and its domain row. The setup page's
 * Notice draws it; the member never sees a price, a registrar reference, an
 * error or the admin's words.
 *
 *   choose       pick a name from the suggestions (again: the one they had went before it was bought)
 *   setting_up   bought; DNS, Vercel and HTTPS are under way ("usually under an hour")
 *   live         working at https://<name>
 *   waiting      waiting for Stayful (auto-buy off, the daily limit, or a problem the admin will see)
 *   none         nothing to show (not live yet, released, or no registrar set up)
 *
 * Pure: no network, no database, no server-only.
 */
import type { DomainStatus } from './types.ts';

export type MemberDomainView =
  | { kind: 'choose'; again: boolean }
  | { kind: 'setting_up'; name: string }
  | { kind: 'live'; address: string }
  | { kind: 'waiting'; name: string }
  | { kind: 'none' };

export interface MemberDomainFacts {
  siteStatus: string;
  row: { status: DomainStatus; name: string } | null;
  /** A domain of this site was released before. */
  releasedBefore: boolean;
  /** Buying is set up (a registrar is configured), so there is something to offer. */
  buyingOn: boolean;
}

export function memberDomainView(f: MemberDomainFacts): MemberDomainView {
  if (f.siteStatus !== 'live') return { kind: 'none' };
  if (!f.row) return f.releasedBefore || !f.buyingOn ? { kind: 'none' } : { kind: 'choose', again: false };
  switch (f.row.status) {
    case 'needs_choice':
      return f.buyingOn ? { kind: 'choose', again: true } : { kind: 'none' };
    case 'registering':
    case 'connecting':
      return { kind: 'setting_up', name: f.row.name };
    case 'live':
      return { kind: 'live', address: `https://${f.row.name}/` };
    case 'awaiting_admin':
    case 'held_cap':
    case 'failed':
      return { kind: 'waiting', name: f.row.name };
    default:
      return { kind: 'none' };
  }
}

/** The plain-English message for a refused choice. */
export function chooseProblemText(reason: string): string {
  switch (reason) {
    case 'not_live':
      return 'Your website needs to be live first.';
    case 'bad_name':
    case 'not_offered':
      return 'Please choose one of the addresses we suggested.';
    case 'offer_expired':
      return 'Those suggestions have expired. We have refreshed them: please choose again.';
    case 'cannot_choose':
      return 'Your web address is already chosen.';
    case 'conflict':
      return 'That address has just been taken. Please choose another.';
    default:
      return 'We could not do that just now. Please try again.';
  }
}
