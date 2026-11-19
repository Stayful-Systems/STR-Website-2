/**
 * Batch 31 phase 12: the words the lead view and the /leads entry card use
 * for a customer website. Pure: no network, no database, no server-only.
 *
 * Plain words for the member who owns the site. Nothing here ever sees the
 * analysis result or an address: the inputs are the report's state, due day,
 * quality flag and self-submit flag, and the site's slug and status.
 */
import type { ReportState, WebsiteStatus } from './types.ts';
import { siteHref } from './urls.ts';

/** "2026-11-20" → "20 Nov 2026" (a date with no time zone, so no shifting). */
export function dueDayText(day: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day ?? '');
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export interface ReportStateInput {
  state: ReportState | string;
  dueDay: string | null;
  qualityOk: boolean | null;
}

export interface ReportStateText {
  label: string;
  detail: string;
  tone: 'ok' | 'warn' | 'bad' | 'neutral';
}

/** The report's state in plain words. */
export function reportStateText(r: ReportStateInput): ReportStateText {
  switch (r.state) {
    case 'awaiting_address':
      return { label: 'Awaiting address', detail: 'They left their details but have not added the property yet (step 2). The lead stays New.', tone: 'neutral' };
    case 'held_cap': {
      const due = dueDayText(r.dueDay);
      return { label: due ? `Held until ${due}` : 'Held', detail: 'Today\'s free reports are used up. The report runs by itself on the day shown, and the landlord was told it will arrive within 24 hours.', tone: 'warn' };
    }
    case 'held_credit':
      return { label: 'Waiting for credit', detail: 'The report runs once your balance covers it. The landlord was told you will be in touch.', tone: 'warn' };
    case 'held_self':
      return { label: 'Not run: self-submit', detail: 'The form was filled in with your own or your team\'s details, so no report was run. The landlord screen said you will be in touch.', tone: 'neutral' };
    case 'running':
      return { label: 'Running', detail: 'The report is being built now.', tone: 'neutral' };
    case 'done':
      return r.qualityOk === false
        ? { label: 'Done: low confidence, early estimate', detail: 'There was limited local data, so the figures are labelled an early estimate. You were not charged for it.', tone: 'warn' }
        : { label: 'Done', detail: 'The report ran and is shown below.', tone: 'ok' };
    case 'failed':
      return { label: 'Failed', detail: 'The report could not be built. The landlord was told you will be in touch.', tone: 'bad' };
    case 'expired':
      return { label: 'Expired', detail: 'Step 2 was never completed within 14 days, so the report will not run.', tone: 'neutral' };
    default:
      return { label: 'Unknown', detail: '', tone: 'neutral' };
  }
}

/**
 * Website leads reach the CRM only through completeLead after the report.
 * Returns the refusal for a manual push, or null when the push may go ahead
 * (no website report row at all, i.e. an ordinary funnel lead, or a done one).
 */
export function websitePushRefusal(state: string | null | undefined): string | null {
  if (state === null || state === undefined || state === 'done') return null;
  return 'This website lead has no completed report yet. Website leads reach your CRM automatically once the report is done.';
}

export interface WebsiteCardInput {
  slug: string;
  status: WebsiteStatus | string;
}

export interface WebsiteCardModel {
  statusLabel: string;
  linkLabel: string | null;
  href: string | null;
}

/** The /leads entry card: status, and where to go next. */
export function websiteCardModel(site: WebsiteCardInput): WebsiteCardModel {
  switch (site.status) {
    case 'invited':
      return { statusLabel: 'Invited', linkLabel: 'Set up your website', href: '/leads/setup/website' };
    case 'setup':
      return { statusLabel: 'Setting up', linkLabel: 'Continue setup', href: '/leads/setup/website' };
    case 'preview':
      return { statusLabel: 'Preview ready', linkLabel: 'Review and approve', href: '/leads/setup/website' };
    case 'live':
      return { statusLabel: 'Live', linkLabel: 'View your website', href: siteHref({ slug: site.slug }) };
    case 'paused':
      return { statusLabel: 'Paused', linkLabel: null, href: null };
    default:
      return { statusLabel: 'Unknown', linkLabel: null, href: null };
  }
}
