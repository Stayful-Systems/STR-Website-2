import { authoriseInternal, internalSecretsConfigured } from '@/lib/internal-auth';
import { createAdminClient, hasServiceRole } from '@/lib/supabase/admin';
import { adminEmails } from '@/lib/admin';
import { isEmailConfigured, sendEmail } from '@/lib/email/send';
import { escapeHtml } from '@/lib/email/escape';
import { siteUrl } from '@/lib/url';
import { readWebsiteSettings } from '@/lib/websites/store-server';
import { runWebsiteReport, type WebsiteReportState } from '@/lib/websites/report-server';

/**
 * Batch 31 phase 7: the customer websites' held-report cron (hourly).
 *
 * A website lead's income report can be held: the day's free limit was full
 * (held_cap, due the next UK day), the owner's credit was short (held_credit),
 * or a run died with its lease (running, lease_until in the past). This is the
 * half that lets those reports run. Every rule about WHETHER one runs is
 * runWebsiteReport's (src/lib/websites/report-server.ts): it claims the slot
 * (p_held = true for a held_cap report, so held reports always fit before new
 * live claims), rechecks the balance, takes the lease with a conditional
 * update, counts the attempt and gives up after the third. This route only
 * picks who to hand it, in order, within a budget.
 *
 * Same auth as the other internal routes: Vercel Cron's bearer or the shared
 * header. A run spends money (the house's, or an owner's), so it never runs open.
 *
 * Order of a real run:
 *   1. due held_cap reports (due_day <= today, UK), oldest first. Skipped while
 *      today's slots are already used up, so a full day does not push every
 *      held report a day further for nothing.
 *   2. held_credit reports, the longest-waiting first. One that is still short
 *      is left alone, and the same website is not tried again this run.
 *   3. stale `running` leases (lease_until in the past): taken again, or failed
 *      after the third attempt (runWebsiteReport decides).
 *   4. awaiting_address / held states older than 14 days become 'expired'. The
 *      lead is never touched: it stays New. Reports that old are not run in 1-2.
 *   Then, once per UK day, one email to the admin when the due backlog is
 *   larger than the day's limit (website_free_reports_per_day).
 *
 * `?dry=1` lists what a real run would do: counts by category and lead ids
 * only. It reads and nothing else: no lease, no spend, no write, no email.
 *
 * A website lead is never status 'queued' (the funnel-queue cron's only
 * input): nothing here, or anywhere under src/lib/websites, sets or leases it.
 *
 * One report's failure never ends the run. Logs carry lead ids and error names
 * only: never an address, and an error's text may carry what a provider was asked.
 */

export const maxDuration = 60;

/** An awaiting_address or held report older than this is expired (website_reports.expires_at's 14 days). */
const EXPIRE_AFTER_DAYS = 14;
/** Each report is a full analysis, and the function has 60 seconds. */
const MAX_HELD_CAP_PER_RUN = 5;
const MAX_HELD_CREDIT_PER_RUN = 5;
const MAX_STALE_PER_RUN = 5;
/** No report is started after this long into the run (maxDuration is 60 s; a run takes most of the rest). */
const START_BUDGET_MS = 15_000;
/** The admin email is skipped after this long: the next hourly run sends it. */
const EMAIL_BUDGET_MS = 45_000;
/** States the 14-day expiry covers (website_reports_expires_idx). */
const EXPIRABLE_STATES = ['awaiting_address', 'held_cap', 'held_credit', 'held_self'] as const;

type Admin = ReturnType<typeof createAdminClient>;
type Step = 'held_cap' | 'held_credit' | 'stale';

interface Candidate {
  leadId: string;
  websiteId: string;
}

interface Listing {
  rows: Candidate[];
  /** Every match, not just the batch. */
  total: number;
}

interface Facts {
  today: string;
  nowIso: string;
  cutoff: string;
  dailyCap: number;
}

// ── What is waiting ──

function toListing(data: unknown, count: number | null, error: { message: string } | null, what: string): Listing {
  if (error) {
    console.error(`[website-reports] ${what} read failed:`, error.message);
    return { rows: [], total: 0 };
  }
  const rows = ((data ?? []) as Array<{ lead_id: string; website_id: string }>).map((r) => ({ leadId: String(r.lead_id), websiteId: String(r.website_id) }));
  return { rows, total: count ?? rows.length };
}

const COLUMNS = 'lead_id, website_id';

/** Held for the day's limit and now due, oldest first. */
async function dueHeldCap(admin: Admin, f: Facts): Promise<Listing> {
  const { data, count, error } = await admin
    .from('website_reports')
    .select(COLUMNS, { count: 'exact' })
    .eq('state', 'held_cap')
    .lte('due_day', f.today)
    .gte('created_at', f.cutoff)
    .order('created_at', { ascending: true })
    .limit(MAX_HELD_CAP_PER_RUN);
  return toListing(data, count, error, 'held_cap');
}

/** Held for credit, the longest-waiting first (a retry that stays short moves to the back: updated_at). */
async function waitingHeldCredit(admin: Admin, f: Facts): Promise<Listing> {
  const { data, count, error } = await admin
    .from('website_reports')
    .select(COLUMNS, { count: 'exact' })
    .eq('state', 'held_credit')
    .gte('created_at', f.cutoff)
    .order('updated_at', { ascending: true })
    .limit(MAX_HELD_CREDIT_PER_RUN);
  return toListing(data, count, error, 'held_credit');
}

/** Running, but the lease has run out (or was never set). */
async function staleRunning(admin: Admin, f: Facts): Promise<Listing> {
  const { data, count, error } = await admin
    .from('website_reports')
    .select(COLUMNS, { count: 'exact' })
    .eq('state', 'running')
    .or(`lease_until.is.null,lease_until.lt.${f.nowIso}`)
    .order('updated_at', { ascending: true })
    .limit(MAX_STALE_PER_RUN);
  return toListing(data, count, error, 'stale');
}

/** How many reports the 14-day expiry would take. */
async function expiryCount(admin: Admin, f: Facts): Promise<number> {
  const { count, error } = await admin
    .from('website_reports')
    .select('lead_id', { count: 'exact', head: true })
    .in('state', [...EXPIRABLE_STATES])
    .lt('created_at', f.cutoff);
  if (error) console.error('[website-reports] expiry read failed:', error.message);
  return count ?? 0;
}

/** Free slots already taken today (UK day). */
async function slotsUsedToday(admin: Admin, f: Facts): Promise<number> {
  const { count, error } = await admin.from('website_report_slots').select('lead_id', { count: 'exact', head: true }).eq('day', f.today);
  if (error) console.error('[website-reports] slots read failed:', error.message);
  return count ?? 0;
}

/** Due held_cap reports still waiting: the backlog. */
async function dueBacklog(admin: Admin, f: Facts): Promise<number> {
  const { count, error } = await admin
    .from('website_reports')
    .select('lead_id', { count: 'exact', head: true })
    .eq('state', 'held_cap')
    .lte('due_day', f.today)
    .gte('created_at', f.cutoff);
  if (error) console.error('[website-reports] backlog read failed:', error.message);
  return count ?? 0;
}

/** Today in the UK, from the database (website_uk_day); the clock in London time when it cannot say. */
async function ukToday(admin: Admin): Promise<string> {
  const { data, error } = await admin.rpc('website_uk_day');
  if (!error && typeof data === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data)) return data;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// ── The dry run: reads only ──

async function dryReport(admin: Admin, f: Facts, started: number) {
  const [heldCap, heldCredit, stale, expiring, used, backlog] = await Promise.all([
    dueHeldCap(admin, f),
    waitingHeldCredit(admin, f),
    staleRunning(admin, f),
    expiryCount(admin, f),
    slotsUsedToday(admin, f),
    dueBacklog(admin, f),
  ]);
  const dayFull = used >= f.dailyCap;
  return {
    dry: true,
    day: f.today,
    // Counts by category; the lead ids are the ones the next run would hand to runWebsiteReport, in order.
    counts: { held_cap: heldCap.total, held_credit: heldCredit.total, stale_running: stale.total, to_expire: expiring },
    wouldRun: {
      // held_cap is skipped while the day's slots are all taken.
      held_cap: dayFull ? [] : heldCap.rows.map((r) => r.leadId),
      held_credit: heldCredit.rows.map((r) => r.leadId),
      stale_running: stale.rows.map((r) => r.leadId),
    },
    day_slots: { used, cap: f.dailyCap, full: dayFull },
    backlog: { due: backlog, cap: f.dailyCap, wouldEmailAdmin: backlog > f.dailyCap },
    ms: Date.now() - started,
  };
}

// ── The real run ──

/** What came of one report, from the state runWebsiteReport reported (never a result, never an address). */
function outcomeOf(step: Step, today: string, s: WebsiteReportState | null): string {
  if (!s) return 'gone';
  switch (s.state) {
    case 'done':
      return 'ran';
    case 'failed':
      return 'failed';
    case 'running':
      // A failed attempt that released its lease, or somebody else's live lease.
      return 'retry_later';
    case 'held_credit':
      return 'still_short';
    case 'held_cap':
      return s.dueDay && s.dueDay > today ? 'held_again' : 'not_due';
    default:
      return s.state;
  }
}

interface Tally {
  outcomes: Array<{ leadId: string; step: Step; outcome: string }>;
  byOutcome: Record<string, number>;
}

async function runBatch(step: Step, rows: Candidate[], f: Facts, started: number, tally: Tally): Promise<void> {
  // A website whose owner is short is not tried again this run.
  const shortSites = new Set<string>();
  for (const row of rows) {
    let outcome: string;
    if (Date.now() - started > START_BUDGET_MS) outcome = 'out_of_time';
    else if (shortSites.has(row.websiteId)) outcome = 'still_short';
    else {
      try {
        outcome = outcomeOf(step, f.today, await runWebsiteReport(row.leadId));
        if (outcome === 'still_short') shortSites.add(row.websiteId);
      } catch (err) {
        // One report's failure never ends the run: the lead id and the error's name, nothing else.
        console.error(`[website-reports] ${step} lead ${row.leadId} threw:`, err instanceof Error ? err.name : 'error');
        outcome = 'error';
      }
    }
    tally.outcomes.push({ leadId: row.leadId, step, outcome });
    tally.byOutcome[`${step}:${outcome}`] = (tally.byOutcome[`${step}:${outcome}`] ?? 0) + 1;
  }
}

/** Awaiting-address and held reports older than 14 days: state 'expired'. The lead is never touched. */
async function expireOld(admin: Admin, f: Facts): Promise<number> {
  const { data, error } = await admin
    .from('website_reports')
    .update({ state: 'expired', lease_until: null, updated_at: f.nowIso })
    .in('state', [...EXPIRABLE_STATES])
    .lt('created_at', f.cutoff)
    .select('lead_id');
  if (error) {
    console.error('[website-reports] expiry failed:', error.message);
    return 0;
  }
  return (data ?? []).length;
}

/** The admin email: counts and the day only, no lead, no name, no address. */
function backlogEmail(day: string, due: number, cap: number) {
  const manage = siteUrl('/admin/management');
  const subject = `Website reports are held over the daily limit (${day})`;
  const text = [
    `${due} website lead reports are due to run and waiting; the free limit is ${cap} a day (UK day ${day}).`,
    'They run, oldest first, as the daily limit allows, before any new ones.',
    `To run them sooner, raise website_free_reports_per_day. Website panel: ${manage}`,
    'You get this once a UK day.',
  ].join('\n\n');
  const html = [
    `<p>${due} website lead reports are due to run and waiting; the free limit is ${cap} a day (UK day ${escapeHtml(day)}).</p>`,
    '<p>They run, oldest first, as the daily limit allows, before any new ones.</p>',
    `<p>To run them sooner, raise <code>website_free_reports_per_day</code>. <a href="${escapeHtml(manage)}">Website panel</a></p>`,
    '<p>You get this once a UK day.</p>',
  ].join('\n');
  return { subject, html, text };
}

/**
 * One admin email per UK day. The once-only claim is Resend's idempotency key
 * (`website-backlog:<day>`, the way the other keyed emails dedupe): the same
 * day again returns the first answer, and sendEmail counts a refused repeat as sent.
 */
async function emailBacklog(day: string, due: number, cap: number): Promise<'sent' | 'failed' | 'skipped'> {
  const to = adminEmails()[0];
  if (!to || !isEmailConfigured()) return 'skipped';
  try {
    const res = await sendEmail({ to, ...backlogEmail(day, due, cap), idempotencyKey: `website-backlog:${day}` });
    return res.sent ? 'sent' : 'failed';
  } catch (err) {
    console.error('[website-reports] backlog email failed:', err instanceof Error ? err.name : 'error');
    return 'failed';
  }
}

async function realRun(admin: Admin, f: Facts, started: number) {
  const tally: Tally = { outcomes: [], byOutcome: {} };

  // 1. Due held_cap reports first: they always fit before new live claims. While today's slots are all
  //    taken, every claim would be refused and pushed a day further, so they wait instead.
  const used = await slotsUsedToday(admin, f);
  const dayFull = used >= f.dailyCap;
  const heldCap = await dueHeldCap(admin, f);
  if (dayFull) {
    for (const r of heldCap.rows) tally.outcomes.push({ leadId: r.leadId, step: 'held_cap', outcome: 'day_full' });
  } else {
    await runBatch('held_cap', heldCap.rows, f, started, tally);
  }

  // 2. held_credit: only while the owner's balance allows; runWebsiteReport rechecks and holds again if short.
  const heldCredit = await waitingHeldCredit(admin, f);
  await runBatch('held_credit', heldCredit.rows, f, started, tally);

  // 3. Stale leases: taken again, or failed after the third attempt.
  //    A report this run has already tried is left for the next run, so a failing one is not retried at once.
  const stale = await staleRunning(admin, f);
  const tried = new Set(tally.outcomes.map((o) => o.leadId));
  await runBatch('stale', stale.rows.filter((r) => !tried.has(r.leadId)), f, started, tally);

  // 4. Old reports expire. The lead stays New.
  const expired = await expireOld(admin, f);

  // The backlog that is left, against the day's limit: one admin email per UK day.
  const backlog = await dueBacklog(admin, f);
  let emailed: 'sent' | 'failed' | 'skipped' | 'not_needed' | 'out_of_time' = 'not_needed';
  if (backlog > f.dailyCap) emailed = Date.now() - started > EMAIL_BUDGET_MS ? 'out_of_time' : await emailBacklog(f.today, backlog, f.dailyCap);

  return {
    dry: false,
    day: f.today,
    considered: { held_cap: heldCap.total, held_credit: heldCredit.total, stale_running: stale.total },
    outcomes: tally.outcomes,
    byOutcome: tally.byOutcome,
    expired,
    backlog: { due: backlog, cap: f.dailyCap, emailed },
    ms: Date.now() - started,
  };
}

export async function GET(request: Request) {
  if (!internalSecretsConfigured()) return new Response('Not found', { status: 404 });
  if (!authoriseInternal(request)) return new Response('Unauthorised', { status: 401 });
  if (!hasServiceRole()) return Response.json({ error: 'service role not configured' }, { status: 503 });

  const dry = new URL(request.url).searchParams.get('dry') === '1';
  const started = Date.now();
  try {
    const admin = createAdminClient();
    const settings = await readWebsiteSettings();
    const facts: Facts = {
      today: await ukToday(admin),
      nowIso: new Date(started).toISOString(),
      cutoff: new Date(started - EXPIRE_AFTER_DAYS * 86_400_000).toISOString(),
      dailyCap: settings.freeReportsPerDay,
    };
    if (dry) return Response.json(await dryReport(admin, facts, started));
    return Response.json(await realRun(admin, facts, started));
  } catch (err) {
    console.error('[website-reports] run failed:', err instanceof Error ? err.name : 'error');
    return Response.json({ error: 'run failed' }, { status: 500 });
  }
}
