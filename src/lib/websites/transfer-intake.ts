/**
 * Batch 37, Phase 6: the lead an operator's EXPORTED website sends back to us.
 *
 * The exported site is plain files on the operator's own host; its form posts
 * (plain HTML, no JavaScript, no Turnstile) to /api/t/<ref>/lead. This is what
 * that route does with the post, with every outside call injected so it runs
 * under `node --test` with counting fakes. The real wiring is in the route.
 *
 * In this exact order:
 *
 *   1. find the transfer by ref and load the site's stub row (owner, funnel),
 *      whatever the site's status (live, paused, switched off: the exported
 *      form must keep working after our copy has stopped). A cancelled
 *      transfer refuses.
 *   2. honeypot filled: a quiet thank-you, nothing saved, nothing counted
 *   3. countAttempt(funnelId, ip, dailyCap): 5 per 10 minutes per IP, and the
 *      funnel's daily cap
 *   4. validateStepOne (the live form's own validator)
 *   5. the same enquiry inside the hour is the same lead (the live route's
 *      dedupe, by email on this funnel); otherwise captureLead(status 'new')
 *      with the address and postcode on the lead's own columns
 *   6. lead_sources (landing = 'exported-site') and the website_reports row
 *      (awaiting_address), once each
 *   7. enqueueLeadDbPush, then the operator's "new landlord lead" email
 *   8. ONLY when the owner's accountStatus is 'paid' AND the address parses as
 *      an analysis input: save leads.input and run the report afterwards.
 *      Otherwise no input is saved, so no report can ever run and nothing is
 *      charged: the lead is captured and pushed, and the operator follows up.
 *
 * Never written here: leads.status (a website lead stays New) and
 * leads.crm_pushed_at. Never imported here: funnel charging or tiers.
 *
 * Log lines carry a lead id and a code at most. Never the form, an address,
 * an email, a phone number or a name.
 *
 * Pure: no network, no database, no server-only.
 */
import { accountStatus, type AccessProfile } from '../access.ts';
import { parseAnalysisInput, type AnalysisInput } from '../analysis/input.ts';
import { reuseSince } from '../leads/dedupe.ts';
import { postcodeAreaOf } from '../listing/normalise.ts';
import { isSelfSubmit } from './policy.ts';
import { parseSources } from './sources.ts';
import { validateStepOne } from './checks.ts';
import type { LeadSourceFields } from './types.ts';

/** The caps' verdict (src/lib/funnels/windows.ts), repeated so this stays free of the server-only caps module. */
export type IntakeCapVerdict = 'ok' | 'daily_cap' | 'ip_throttle' | 'spend_cap' | 'unavailable';

/** Where the exported form's lead says it came from (lead_sources.landing_page). */
export const EXPORTED_LANDING = 'exported-site';

/**
 * What the thank-you page is told, in the address (?r=):
 *   report   a report is being made and will be emailed
 *   contact  the lead is saved; the operator will be in touch
 *   check    the details were not accepted: go back and check them
 *   wait     not accepted for now (too many in a row, a limit, or we could not save): try again shortly
 */
export type IntakeOutcome = 'report' | 'contact' | 'check' | 'wait';
export const INTAKE_OUTCOMES: readonly IntakeOutcome[] = ['report', 'contact', 'check', 'wait'];

export type IntakeResult = { kind: 'done'; outcome: IntakeOutcome } | { kind: 'not_found' };

/** What the intake needs of the transfer and its site's stub row. */
export interface IntakeTarget {
  transferId: string;
  cancelled: boolean;
  site: {
    id: string;
    /** The account owner. */
    userId: string;
    funnelId: string;
    contactEmail: string;
    contactPhone: string;
  };
}

export interface IntakeCapture {
  userId: string;
  funnelId: string;
  contact: { name: string; email: string; phone: string; consentAt: string };
  property: { address: string | null; postcode: string | null; bedrooms: number | null };
  status: 'new';
}

export interface IntakeDeps {
  now: () => Date;
  /** The open or finished transfer with this ref and its site's stub row (any site status), or null. */
  loadTransfer: (ref: string) => Promise<IntakeTarget | null>;
  /** The funnel's daily cap, or null when it cannot be read. */
  dailyCapOf: (funnelId: string, userId: string) => Promise<number | null>;
  countAttempt: (funnelId: string, ip: string, dailyCap: number) => Promise<IntakeCapVerdict>;
  /** The id of this email's lead on this funnel created since `since`, if any. */
  recentLeadId: (o: { funnelId: string; userId: string; email: string; since: string }) => Promise<string | null>;
  captureLead: (input: IntakeCapture) => Promise<{ id: string } | null>;
  saveSources: (leadId: string, sources: LeadSourceFields) => Promise<void>;
  /** The owner's account email and mobile, for the self-submit check. */
  ownerContact: (ownerId: string) => Promise<{ email: string | null; phone: string | null }>;
  /** Inserts the website_reports row (awaiting_address), once: on conflict it changes nothing. */
  saveReportRow: (o: { leadId: string; websiteId: string; selfSubmit: boolean }) => Promise<void>;
  /** The report row's state, or null when there is none. */
  reportState: (leadId: string) => Promise<string | null>;
  /** The Batch 32 hook. Never throws; never waited for. */
  enqueueLeadDbPush: (leadId: string) => Promise<unknown>;
  notifyOperator: (o: { leadId: string; websiteId: string }) => Promise<unknown>;
  /** The owner's plan columns (ACCESS_COLUMNS), or null when unreadable. */
  ownerProfile: (ownerId: string) => Promise<AccessProfile | null>;
  /** Saves the parsed property and leads.input exactly as the live report route does. False on failure, or when the lead already holds an input. */
  saveInput: (o: { leadId: string; userId: string; funnelId: string; input: AnalysisInput }) => Promise<boolean>;
  /** Runs the report after the response is sent (the route passes next/server's `after`). */
  runReportLater: (leadId: string) => void;
  /** One log line: ids and codes only. */
  log: (line: string) => void;
}

export interface IntakeRequest {
  ref: string;
  ip: string;
  /** The decoded form: string values only. */
  form: Record<string, string>;
}

// ── Reading the form ──

const FIELD_MAX = 2000;
const ADDRESS_MAX = 200;
const POSTCODE_MAX = 10;

/** The honeypot's field names: the live form's JSON key and its page field. A person never sees either. */
const HONEYPOTS = ['hp', 'hp_company_site'] as const;

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

/** A checkbox as a form sends it: present as "on", "true", "1" or "yes" means ticked; absent means not. */
export function consentTicked(v: unknown): boolean {
  return typeof v === 'string' && /^(on|true|1|yes)$/i.test(v.trim());
}

function bedroomsOf(v: unknown): number | null {
  if (typeof v !== 'string' || !/^\d{1,2}$/.test(v.trim())) return null;
  const n = Number(v);
  return n >= 0 && n <= 10 ? n : null;
}

/** The only fields a visitor may set on the report's input (the live report route's list, less what this form lacks). */
function analysisBody(form: Record<string, string>, email: string): Record<string, unknown> {
  return {
    address: form.address,
    postcode: form.postcode,
    // An empty choice is missing, not zero: Number('') is 0, which would read as a studio.
    bedrooms: form.bedrooms?.trim() ? form.bedrooms : undefined,
    guests: form.guests?.trim() ? form.guests : undefined,
    propertyType: form.propertyType,
    bathrooms: form.bathrooms,
    parking: form.parking,
    outdoorSpace: form.outdoorSpace,
    email,
  };
}

/** The outcome in a thank-you address (?r=). Anything unknown reads as "contact": the quiet, true-enough answer. */
export function outcomeOf(raw: unknown): IntakeOutcome {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return INTAKE_OUTCOMES.find((o) => o === v) ?? 'contact';
}

/** The words on the thank-you page. `company` is the operator's name from the transfer's snapshot ('' when none). */
export function thanksCopy(outcome: IntakeOutcome, company: string): { heading: string; body: string } {
  const who = company.trim() || 'We';
  switch (outcome) {
    case 'report':
      return { heading: 'Thank you', body: 'Your income report is on its way by email.' };
    case 'check':
      return { heading: 'Please go back and check', body: 'We could not use the details you sent. Please go back, check them and send the form again.' };
    case 'wait':
      return { heading: 'Please try again shortly', body: 'We could not take your details just now. Please go back and try again in a few minutes.' };
    default:
      return { heading: 'Thank you', body: `${who} will be in touch.` };
  }
}

/** The origin of the page the form was on, for a "Back" link: only when the Referer is an http(s) address. Else null. */
export function backOrigin(referer: string | null | undefined): string | null {
  if (!referer) return null;
  try {
    const u = new URL(referer);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

const done = (outcome: IntakeOutcome): IntakeResult => ({ kind: 'done', outcome });

/** Handles one post of the exported form. Never throws on bad input; a dependency that throws is the route's to catch. */
export async function takeExportedLead(req: IntakeRequest, deps: IntakeDeps): Promise<IntakeResult> {
  const form = req.form;

  // ── 1. The transfer and the site's stub row. A site that is paused or switched off still takes the form. ──
  const target = await deps.loadTransfer(req.ref);
  if (!target) return { kind: 'not_found' };
  if (target.cancelled) return done('check');
  const { site } = target;

  // ── 2. The honeypot: filled means a bot. A quiet thank-you, nothing saved, nothing counted. ──
  if (HONEYPOTS.some((k) => text(form[k], FIELD_MAX) !== '')) return done('contact');

  // ── 3. The caps, against the site's own funnel: the per-IP window and the funnel's daily share. ──
  const dailyCap = await deps.dailyCapOf(site.funnelId, site.userId);
  if (dailyCap === null) return done('wait');
  const verdict = await deps.countAttempt(site.funnelId, req.ip, dailyCap);
  if (verdict !== 'ok') return done('wait');

  // ── 4. Validate. Consent is required: without it nothing is written. ──
  const checked = validateStepOne({ name: form.name, email: form.email, phone: form.phone, consent: consentTicked(form.consent) });
  if (!checked.ok) return done('check');
  const { name, email, phone } = checked.clean;
  const now = deps.now();

  // ── 5. The lead: the same enquiry inside the hour is the same lead. ──
  let leadId = await deps.recentLeadId({ funnelId: site.funnelId, userId: site.userId, email, since: reuseSince(now) });
  if (!leadId) {
    const address = text(form.address, ADDRESS_MAX) || null;
    const postcode = text(form.postcode, POSTCODE_MAX).toUpperCase() || null;
    const captured = await deps.captureLead({
      userId: site.userId,
      funnelId: site.funnelId,
      contact: { name, email, phone, consentAt: now.toISOString() },
      property: { address, postcode, bedrooms: bedroomsOf(form.bedrooms) },
      // A website lead is New from the moment it is saved. Nothing here queues it for the drain.
      status: 'new',
    });
    if (!captured) {
      deps.log('[transfer-lead] capture failed');
      return done('wait');
    }
    leadId = captured.id;
  }

  // ── 6. Attribution and the report row, once each. ──
  const sources = parseSources(
    Object.fromEntries(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'ad'].map((k) => [k, text(form[k], FIELD_MAX)])),
  );
  await deps.saveSources(leadId, { ...sources, landing_page: EXPORTED_LANDING });

  const owner = await deps.ownerContact(site.userId);
  const selfSubmit = isSelfSubmit({
    leadEmail: email,
    leadPhone: phone,
    ownerEmail: owner.email,
    ownerPhone: owner.phone,
    siteEmail: site.contactEmail,
    sitePhone: site.contactPhone,
    sessionUserId: null,
    ownerUserId: site.userId,
    teamUserIds: [],
  });
  await deps.saveReportRow({ leadId, websiteId: site.id, selfSubmit });

  // ── 7. The lead database, then the operator's email. Neither can fail the post. ──
  void deps.enqueueLeadDbPush(leadId).catch(() => {});
  await deps.notifyOperator({ leadId, websiteId: site.id });

  // ── 8. A report only for a paid plan and a usable address. Otherwise no input is saved, so none can ever run. ──
  const profile = await deps.ownerProfile(site.userId);
  if (!profile || accountStatus(profile, now.getTime()) !== 'paid') return done('contact');
  if ((await deps.reportState(leadId)) !== 'awaiting_address') return done('contact');
  const parsed = parseAnalysisInput(analysisBody(form, email));
  if (!parsed.ok) return done('contact');
  const input: AnalysisInput = { ...parsed.input, enhancedRequested: false };
  const saved = await deps.saveInput({ leadId, userId: site.userId, funnelId: site.funnelId, input });
  if (!saved) {
    deps.log(`[transfer-lead] input not saved for lead ${leadId}`);
    return done('contact');
  }
  deps.runReportLater(leadId);
  return done('report');
}

/** The address of the lead's own columns for a parsed input (the live report route's update), for the route's saveInput. */
export function inputColumns(input: AnalysisInput): { address: string; postcode: string; postcode_area: string | null; bedrooms: number; input: AnalysisInput } {
  return {
    address: input.property.address,
    postcode: input.property.postcode,
    postcode_area: postcodeAreaOf(input.property.postcode),
    bedrooms: input.property.bedrooms,
    input,
  };
}
