/**
 * Batch 31, Phase 11: the pure logic behind the admin panel's "Give a website",
 * the pause / unpause plan and the five settings' validation. Pure: no network,
 * no database, no server-only, so `node --test` runs it.
 *
 * "Give a website" has two buttons that share ONE checklist:
 *
 *   dryRunInvite(facts)       the checklist and whether the run would go ahead.
 *                             Never writes: it is a pure function of the facts
 *                             the caller READ, and takes no way to write.
 *   runInvite(facts, invite)  the same checklist, then `invite()` only when
 *                             every line passes. `invite` is what writes
 *                             (inviteWebsite); it is not called on any refusal.
 *
 * invite-run.test.ts proves the dry run path by behaviour (a spy that must not
 * be called) and by source pin (the dry-run action and this file's dry-run
 * function contain no insert / update / upsert / rpc / inviteWebsite call).
 *
 * The facts hold no lead contact details and no address: a member's email (the
 * operator, not a landlord's lead) is the most personal thing in here.
 */
import { slugProblem, slugProblemText } from './slug.ts';
import { websiteAccess } from './policy.ts';
import type { WebsiteSettings } from './settings.ts';

// ── Give a website ──

export type CheckState = 'pass' | 'fail' | 'skip';
export type InviteCheckKey = 'member' | 'management' | 'owner' | 'no_site' | 'slug_valid' | 'slug_free' | 'plan_gate';

export interface ChecklistItem {
  key: InviteCheckKey;
  label: string;
  state: CheckState;
  detail: string;
}

export interface InviteChecklist {
  /** The email and slug as the checks saw them (trimmed, lowercase). */
  email: string;
  slug: string;
  items: ChecklistItem[];
  /** Every line passed (a skipped line only follows a failed one). */
  canRun: boolean;
}

/** What the caller READ before asking. No writes are needed to gather these. */
export interface InviteFacts {
  email: string;
  slug: string;
  /** The profile with that email, or null. */
  member: { id: string; isManagement: boolean; paid: boolean } | null;
  /** ownerIdOrNull(member) === member.id: an account owner, not a team member. */
  isOwner: boolean;
  /** The member already has a website (one site per member). */
  hasSite: boolean;
  /** Another website already uses this slug (only read for a valid slug). */
  slugTaken: boolean;
  /** website_plan_gate_on. */
  planGateOn: boolean;
}

export const normaliseEmail = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');
export const normaliseSlug = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const looksLikeEmail = (v: string): boolean => EMAIL.test(v) && v.length <= 254;

const item = (key: InviteCheckKey, label: string, state: CheckState, detail: string): ChecklistItem => ({ key, label, state, detail });

/** The checklist, one line per thing that must be true. Pure. */
export function inviteChecklist(f: InviteFacts): InviteChecklist {
  const email = normaliseEmail(f.email);
  const slug = normaliseSlug(f.slug);
  const items: ChecklistItem[] = [];

  // Member lines: each is skipped when the member was not found.
  if (!looksLikeEmail(email)) items.push(item('member', 'Member found', 'fail', 'That is not an email address.'));
  else if (!f.member) items.push(item('member', 'Member found', 'fail', 'No account with that email.'));
  else items.push(item('member', 'Member found', 'pass', 'An account with that email exists.'));
  const m = looksLikeEmail(email) ? f.member : null;

  items.push(
    !m
      ? item('management', 'Management company account', 'skip', 'Needs a member first.')
      : m.isManagement
        ? item('management', 'Management company account', 'pass', 'Signed up as a management company.')
        : item('management', 'Management company account', 'fail', 'Not a management company account: only those can have a website.'),
  );
  items.push(
    !m
      ? item('owner', 'Account owner', 'skip', 'Needs a member first.')
      : f.isOwner
        ? item('owner', 'Account owner', 'pass', 'They own their account.')
        : item('owner', 'Account owner', 'fail', 'A team member: only the account owner can have a website.'),
  );
  items.push(
    !m
      ? item('no_site', 'No website yet', 'skip', 'Needs a member first.')
      : f.hasSite
        ? item('no_site', 'No website yet', 'fail', 'They already have a website (one per member).')
        : item('no_site', 'No website yet', 'pass', 'They have no website.'),
  );

  // Slug lines stand on their own.
  const problem = slugProblem(slug);
  items.push(problem ? item('slug_valid', 'Address valid', 'fail', slugProblemText(problem)) : item('slug_valid', 'Address valid', 'pass', `/s/${slug} is a valid address.`));
  items.push(
    problem
      ? item('slug_free', 'Address free', 'skip', 'Needs a valid address first.')
      : f.slugTaken
        ? item('slug_free', 'Address free', 'fail', 'Another website already uses that address.')
        : item('slug_free', 'Address free', 'pass', 'Nobody uses that address.'),
  );

  // Plan gate: the state, and whether it blocks THIS member.
  if (!m) items.push(item('plan_gate', 'Plan gate', 'skip', f.planGateOn ? 'The plan gate is on: a paid plan will be needed.' : 'The plan gate is off: no plan needed.'));
  else {
    const gate = websiteAccess({ isManagement: true, isOwner: true, invited: false, paid: m.paid }, f.planGateOn, 'invite');
    items.push(
      gate.allowed
        ? item('plan_gate', 'Plan gate', 'pass', f.planGateOn ? 'The plan gate is on and they have a paid plan.' : 'The plan gate is off: no plan needed.')
        : item('plan_gate', 'Plan gate', 'fail', 'The plan gate is on and they have no paid plan.'),
    );
  }

  return { email, slug, items, canRun: items.every((i) => i.state === 'pass') };
}

/** The dry run: the checklist and nothing else. It writes nothing and has nothing to write with. */
export function dryRunInvite(facts: InviteFacts): InviteChecklist {
  return inviteChecklist(facts);
}

export type RunInviteResult<T> = { ran: false; checklist: InviteChecklist } | { ran: true; checklist: InviteChecklist; result: T };

/** The run: the same checklist, then `invite` only when every line passes. */
export async function runInvite<T>(facts: InviteFacts, invite: () => Promise<T>): Promise<RunInviteResult<T>> {
  const checklist = inviteChecklist(facts);
  if (!checklist.canRun) return { ran: false, checklist };
  return { ran: true, checklist, result: await invite() };
}

/** inviteWebsite's refusal, in words (a race can still refuse after the checklist passed). */
export function inviteDenialText(reason: string): string {
  switch (reason) {
    case 'not_management':
      return 'Not a management company account.';
    case 'not_owner':
      return 'Not an account owner.';
    case 'plan_required':
      return 'The plan gate is on and they have no paid plan.';
    case 'already_has_site':
      return 'They already have a website.';
    case 'slug_invalid':
      return 'That address is not valid.';
    case 'slug_taken':
      return 'Another website already uses that address.';
    default:
      return 'The website could not be created. Nothing was changed.';
  }
}

// ── Pause / unpause ──

export type SiteAction = 'pause' | 'unpause';

export interface SiteStatusPlan {
  ok: boolean;
  /** The status after, when ok. */
  to: 'paused' | 'live' | null;
  /** What changes (or why nothing can), one line each. */
  lines: string[];
}

/**
 * What a pause or unpause would change. Pausing is live -> paused and nothing
 * else; unpausing is paused -> live. Nothing is deleted either way. Pure.
 */
export function planSiteStatus(site: { slug: string; status: string }, action: SiteAction): SiteStatusPlan {
  const path = `/s/${site.slug}`;
  if (action === 'pause') {
    if (site.status !== 'live') return { ok: false, to: null, lines: [`Only a live site can be paused (this one is ${site.status}).`] };
    return {
      ok: true,
      to: 'paused',
      lines: [
        'Status: live → paused. paused_at is set to now.',
        `${path} and every page under it answer 404 straight away, so a visitor part-way through the form cannot finish it.`,
        'Nothing is deleted: the settings, page copy, leads, reports and held reports all stay.',
        'Reports already held keep their place; the member can still see their leads.',
      ],
    };
  }
  if (site.status !== 'paused') return { ok: false, to: null, lines: [`Only a paused site can be unpaused (this one is ${site.status}).`] };
  return {
    ok: true,
    to: 'live',
    lines: ['Status: paused → live. paused_at is cleared; the first live date is kept.', `${path} serves its pages again straight away.`, 'Nothing else changes.'],
  };
}

// ── The five settings ──

export const SETTING_LIMITS = {
  /** Pence per report, when charging is on: at least 1p, at most £100. */
  pence: { min: 1, max: 10_000 },
  /** Free reports per UK day, all sites / one site. 0 stops them. */
  perDay: { min: 0, max: 1000 },
} as const;

export type SettingsErrors = Partial<Record<keyof WebsiteSettings, string>>;
export type SettingsValidation = { ok: true; values: WebsiteSettings } | { ok: false; errors: SettingsErrors };

/** A strict switch: true / false or "true" / "false", nothing else. */
function strictBool(raw: unknown): boolean | null {
  if (raw === true || raw === 'true') return true;
  if (raw === false || raw === 'false') return false;
  return null;
}

/** A whole number: an integer, or a string of digits (no sign, no decimals, no spaces inside). */
function wholeNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : null;
  if (typeof raw === 'string' && /^\d{1,9}$/.test(raw.trim())) return Number(raw.trim());
  return null;
}

/**
 * Validates the five settings as typed. Booleans are strict, integers are whole
 * and at least 0, pence is 1-10000, and one site's free reports can never
 * exceed the daily total. Every field's problem is returned, not just the first.
 */
export function validateWebsiteSettings(input: Record<keyof WebsiteSettings, unknown>): SettingsValidation {
  const errors: SettingsErrors = {};
  const reportChargeOn = strictBool(input.reportChargeOn);
  if (reportChargeOn === null) errors.reportChargeOn = 'Choose on or off.';
  const planGateOn = strictBool(input.planGateOn);
  if (planGateOn === null) errors.planGateOn = 'Choose on or off.';

  const pence = wholeNumber(input.reportPence);
  if (pence === null) errors.reportPence = 'A whole number of pence.';
  else if (pence < SETTING_LIMITS.pence.min || pence > SETTING_LIMITS.pence.max) errors.reportPence = `Between ${SETTING_LIMITS.pence.min} and ${SETTING_LIMITS.pence.max} pence.`;

  const perDay = wholeNumber(input.freeReportsPerDay);
  if (perDay === null) errors.freeReportsPerDay = 'A whole number, 0 or more.';
  else if (perDay > SETTING_LIMITS.perDay.max) errors.freeReportsPerDay = `At most ${SETTING_LIMITS.perDay.max}.`;

  const perSite = wholeNumber(input.freeReportsPerSitePerDay);
  if (perSite === null) errors.freeReportsPerSitePerDay = 'A whole number, 0 or more.';
  else if (perSite > SETTING_LIMITS.perDay.max) errors.freeReportsPerSitePerDay = `At most ${SETTING_LIMITS.perDay.max}.`;
  else if (perDay !== null && perSite > perDay) errors.freeReportsPerSitePerDay = 'One site cannot have more than the daily total for all sites.';

  if (Object.keys(errors).length > 0 || reportChargeOn === null || planGateOn === null || pence === null || perDay === null || perSite === null) return { ok: false, errors };
  return { ok: true, values: { reportChargeOn, reportPence: pence, planGateOn, freeReportsPerDay: perDay, freeReportsPerSitePerDay: perSite } };
}

const LABELS: Record<keyof WebsiteSettings, string> = {
  reportChargeOn: 'Charge for reports',
  reportPence: 'Report price (pence)',
  planGateOn: 'Plan gate',
  freeReportsPerDay: 'Free reports a day, all sites',
  freeReportsPerSitePerDay: 'Free reports a day, one site',
};

export const SETTING_LABELS = LABELS;

const show = (v: boolean | number): string => (typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v));

/** "Plan gate: off → on" for each setting that changed. */
export function describeSettingsChanges(before: WebsiteSettings, after: WebsiteSettings): string[] {
  return (Object.keys(LABELS) as Array<keyof WebsiteSettings>).filter((k) => before[k] !== after[k]).map((k) => `${LABELS[k]}: ${show(before[k])} → ${show(after[k])}`);
}

// ── The site list ──

/** How many times each id appears. */
export function countBy(ids: ReadonlyArray<unknown>): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of ids) {
    if (typeof id !== 'string') continue;
    out.set(id, (out.get(id) ?? 0) + 1);
  }
  return out;
}

/** The start of the "this week" window: seven days before `now`. */
export function weekStart(now: Date): string {
  return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
}
