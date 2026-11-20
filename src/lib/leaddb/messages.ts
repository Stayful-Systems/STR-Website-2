/**
 * What the connect screen and the lead badge say, in plain English (Batch 32).
 * Codes in, sentences out; nothing from the other side's response is ever
 * shown as it came. Pure.
 */

export const NOT_AVAILABLE = 'Lead database link not available yet';
export const GET_THE_LEAD_DATABASE_URL = 'https://leads.stayful.co.uk';

const TEXT: Record<string, string> = {
  not_configured: NOT_AVAILABLE,
  not_available: NOT_AVAILABLE,
  bad_signature: NOT_AVAILABLE,
  no_account: 'We could not find a lead database account for that email.',
  no_product: 'That account does not have a lead plan yet, so there is nowhere for these leads to go.',
  rate_limited: 'Too many codes asked for. Please wait an hour and try again.',
  wrong_code: 'That code is not right. Check the email and try again.',
  expired_code: 'That code has expired. Send a new one.',
  too_many_attempts: 'Too many wrong codes. Send a new one.',
  unknown_link: 'That connection could not be found. Send a new code.',
  not_linked: 'The lead database no longer has this connection. Connect again to carry on.',
  in_progress: 'The lead database is still working on it. We will try again shortly.',
  network: 'We could not reach the lead database. We will try again shortly.',
  timeout: 'The lead database took too long to answer. We will try again shortly.',
  bad_request: 'The lead database could not read that. Please try again.',
  bad_report: 'The lead database could not accept the report. We will keep the lead and try again.',
  too_large: 'The report was too large for the lead database.',
  lead_gone: 'The lead no longer exists, so there was nothing to send.',
  archived: 'The lead was archived before it could be sent.',
  not_a_website_lead: 'That lead did not come from a website, so it is not sent.',
  owner_mismatch: 'The lead does not belong to the connected account.',
  report_not_sent: 'The lead is in the lead database, but its report could not be built yet. We will try again.',
  report_not_attached: 'The lead is in the lead database, but its report was not attached yet. We will try again.',
};

/** A sentence for a code; an unknown code reads as a generic try-again, never as the code itself. */
export function leadDbMessage(code: string | null | undefined): string {
  if (!code) return 'Something went wrong. Please try again.';
  if (TEXT[code]) return TEXT[code];
  if (/^http_5\d\d$/.test(code)) return 'The lead database had a problem. We will try again shortly.';
  return 'Something went wrong. Please try again.';
}

/** Whether a code means "show the Get the lead database link". */
export const needsAccount = (code: string | null | undefined) => code === 'no_account';

export interface BadgeInput {
  deliveryStatus: 'pending' | 'sent' | 'failed' | null;
  leadSent: boolean;
  reportSent: boolean;
  /** The report finished with no figures: nothing is coming. */
  noReport?: boolean;
}

/** The badge on a lead: null when it never went (or will not go). */
export function leadDbBadge(d: BadgeInput | null): string | null {
  if (!d || !d.leadSent) return null;
  return d.reportSent || d.noReport ? 'In your lead database' : 'In your lead database · report coming';
}
