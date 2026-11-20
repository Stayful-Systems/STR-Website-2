/**
 * Batch 33: the status cron's brain (every 15 minutes), with everything
 * outside it injected so it is tested without a database, a registrar or Vercel.
 * The route (src/app/api/internal/domains/route.ts) wires the real ones.
 *
 * ORDER of a real run (pinned by cron.test.ts):
 *   1. held_cap from an earlier UK day            buy
 *   2. registering, untouched for 15 minutes      buy again (it asks the registrar whether we own the name first)
 *   3. connecting                                 advance (live domains whose "live" email did not go: send it again)
 *   4. stuck for 24 hours                         one admin email, stamps stuck_alerted_at
 *   5. renewals within 30 days                    one admin email per domain per period (renewal_alerted_for)
 *   6. 7 days or fewer, nobody decided            the auto-renew rule: renew when the site is live and not switched off
 *                                                 (the cap is the spend claim's); one admin email per period (autorenew_alerted_for)
 *   7. renew decisions                            renew
 * No new piece of work starts after 40 seconds (maxDuration is 60). One domain's
 * failure never ends the run.
 *
 * `dry` is read-only: it lists what a real run would do, from our own database
 * only: no registrar, no Vercel, no email, no write.
 *
 * Nothing here logs a body, a header or a credential.
 *
 * Pure of server-only and the network: injected.
 */
import type { EmailCopy } from '../email/new-lead.ts';
import { domainAutoRenewEmail, domainRenewalEmail, domainStuckEmail } from '../email/domain.ts';
import { AUTO_RENEW_DAYS, REGISTERING_RESUME_MINUTES, STUCK_HOURS, type DomainRow, type DomainStatus } from './types.ts';
import { daysToExpiry, inRenewalWindow, isStuck, renewalPeriod } from './policy.ts';
import type { DomainEngine, DomainPatch } from './purchase-server.ts';

/** No new work after this long into the run. */
export const START_BUDGET_MS = 40_000;

export interface CronDeps {
  engine: DomainEngine;
  /** Rows in these statuses (the route reads website_domains; a dry run uses only this and the verdicts). */
  list: (statuses: readonly DomainStatus[]) => Promise<DomainRow[]>;
  /** A stamp on a row (store.updateDomain). */
  stamp: (id: string, patch: DomainPatch) => Promise<unknown>;
  /** One admin email; true when it went. `key` is Resend's idempotency key. */
  sendAdmin: (copy: EmailCopy, key: string) => Promise<boolean>;
  panelUrl: string;
  now: () => Date;
  /** Milliseconds on a monotonic-ish clock, for the budget. */
  clock?: () => number;
}

const ALL: readonly DomainStatus[] = ['awaiting_admin', 'held_cap', 'registering', 'connecting', 'live', 'failed', 'releasing'];

/** The UK calendar day (YYYY-MM-DD) of an instant. */
export function ukDay(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

const humanDate = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));

export interface Plan {
  heldCap: DomainRow[];
  registering: DomainRow[];
  connecting: DomainRow[];
  resendEmail: DomainRow[];
  stuck: DomainRow[];
  renewalWindow: DomainRow[];
  autoRenew: DomainRow[];
  renewDecisions: DomainRow[];
}

/** What a real run would touch, from our own rows and the auto-renew verdicts (reads only). */
export async function plan(deps: CronDeps): Promise<Plan> {
  const now = deps.now();
  const rows = await deps.list(ALL);
  const today = ukDay(now);
  const staleBefore = now.getTime() - REGISTERING_RESUME_MINUTES * 60_000;

  const live = rows.filter((r) => r.status === 'live');
  const autoRenew: DomainRow[] = [];
  for (const r of live) {
    const d = daysToExpiry(r.expiresAt, now);
    if (r.renewDecision || d === null || d > AUTO_RENEW_DAYS || !r.expiresAt) continue;
    const verdict = await deps.engine.autoRenewVerdict(r);
    // Renew now, or tell the admin once per period why it will not be renewed.
    if (verdict === 'renew' || ((verdict === 'skip_site_off' || verdict === 'skip_not_allowed') && r.autoRenewAlertedFor !== renewalPeriod(r.expiresAt))) autoRenew.push(r);
  }

  return {
    heldCap: rows.filter((r) => r.status === 'held_cap' && ukDay(new Date(r.stateChangedAt)) < today),
    registering: rows.filter((r) => r.status === 'registering' && new Date(r.updatedAt).getTime() < staleBefore),
    connecting: rows.filter((r) => r.status === 'connecting'),
    resendEmail: live.filter((r) => r.lastError === 'email_not_sent'),
    stuck: rows.filter((r) => isStuck(r.status, r.stateChangedAt, now) && (!r.stuckAlertedAt || r.stuckAlertedAt < r.stateChangedAt)),
    renewalWindow: live.filter((r) => inRenewalWindow(r.status, r.expiresAt, now) && r.expiresAt && r.renewalAlertedFor !== renewalPeriod(r.expiresAt)),
    autoRenew,
    renewDecisions: live.filter((r) => r.renewDecision === 'renew'),
  };
}

export interface RunReport {
  dry: boolean;
  counts: Record<keyof Plan, number>;
  /** Domain ids a real run would hand to each step (a dry run) or did hand (a real run). */
  ids: Record<keyof Plan, string[]>;
  /** Real run only: what came of each one. */
  outcomes?: Array<{ step: keyof Plan; id: string; outcome: string }>;
  emails?: { sent: number; failed: number };
}

function summarise(p: Plan): Pick<RunReport, 'counts' | 'ids'> {
  const keys = Object.keys(p) as Array<keyof Plan>;
  return {
    counts: Object.fromEntries(keys.map((k) => [k, p[k].length])) as Record<keyof Plan, number>,
    ids: Object.fromEntries(keys.map((k) => [k, p[k].map((r) => r.id)])) as Record<keyof Plan, string[]>,
  };
}

export async function runDomains(deps: CronDeps, opts: { dry: boolean }): Promise<RunReport> {
  const p = await plan(deps);
  if (opts.dry) return { dry: true, ...summarise(p) };

  const clock = deps.clock ?? Date.now;
  const started = clock();
  const outcomes: NonNullable<RunReport['outcomes']> = [];
  const emails = { sent: 0, failed: 0 };
  const out = (step: keyof Plan, id: string, outcome: string) => outcomes.push({ step, id, outcome });
  const hasTime = () => clock() - started < START_BUDGET_MS;

  async function each(step: keyof Plan, rows: DomainRow[], work: (r: DomainRow) => Promise<string>) {
    for (const r of rows) {
      if (!hasTime()) {
        out(step, r.id, 'out_of_time');
        continue;
      }
      try {
        out(step, r.id, await work(r));
      } catch (e) {
        // One domain's failure never ends the run: the error's name only.
        out(step, r.id, `error:${e instanceof Error ? e.name : 'error'}`);
      }
    }
  }

  async function email(copy: EmailCopy, key: string): Promise<boolean> {
    const ok = await deps.sendAdmin(copy, key).catch(() => false);
    if (ok) emails.sent += 1;
    else emails.failed += 1;
    return ok;
  }

  // 1. held_cap from an earlier UK day.
  await each('heldCap', p.heldCap, async (r) => (await deps.engine.buy(r.id, {})).outcome);
  // 2. registering for 15 minutes: buy again (ownership is checked first, inside).
  await each('registering', p.registering, async (r) => (await deps.engine.buy(r.id, {})).outcome);
  // 3. connecting: advance. A live domain whose email did not go gets it again.
  await each('connecting', p.connecting, async (r) => (await deps.engine.advance(r.id)).outcome);
  await each('resendEmail', p.resendEmail, async (r) => (await deps.engine.resendLiveEmail(r.id)).outcome);
  // 4. stuck for 24 hours: one admin email, then the stamp.
  await each('stuck', p.stuck, async (r) => {
    const ok = await email(domainStuckEmail({ domain: r.name, status: r.status, hours: STUCK_HOURS, panelUrl: deps.panelUrl }), `domain-stuck:${r.id}:${r.stateChangedAt}`);
    if (ok) await deps.stamp(r.id, { stuckAlertedAt: deps.now().toISOString() });
    return ok ? 'emailed' : 'email_failed';
  });
  // 5. renewals within 30 days: one admin email per domain per period.
  await each('renewalWindow', p.renewalWindow, async (r) => {
    const expires = r.expiresAt as string;
    const period = renewalPeriod(expires);
    const days = daysToExpiry(expires, deps.now()) ?? 0;
    const autoOn = new Date(new Date(expires).getTime() - AUTO_RENEW_DAYS * 86_400_000).toISOString();
    const ok = await email(domainRenewalEmail({ domain: r.name, expires: humanDate(expires), days, autoRenewOn: humanDate(autoOn), panelUrl: deps.panelUrl }), `domain-renewal:${r.id}:${period}`);
    if (ok) await deps.stamp(r.id, { renewalAlertedFor: period });
    return ok ? 'emailed' : 'email_failed';
  });
  // 6. 7 days or fewer, nobody decided: the auto-renew rule.
  await each('autoRenew', p.autoRenew, async (r) => {
    const verdict = await deps.engine.autoRenewVerdict(r);
    const period = renewalPeriod(r.expiresAt as string);
    const tell = async (outcome: 'renewed' | 'held' | 'skipped', reason: string | null) => {
      // The outcome is in the key: a "held" and a later "renewed" are different emails, each sent once.
      const ok = await email(domainAutoRenewEmail({ domain: r.name, outcome, reason, panelUrl: deps.panelUrl }), `domain-autorenew:${r.id}:${period}:${outcome}`);
      if (ok) await deps.stamp(r.id, { autoRenewAlertedFor: period });
    };
    if (verdict === 'renew') {
      const res = await deps.engine.renew(r.id, {});
      if (res.outcome.startsWith('renewed')) await tell('renewed', null);
      // Over the daily cap: say so once; the next run (next UK day) tries again.
      else if (res.outcome === 'held_cap' && r.autoRenewAlertedFor !== period) await tell('held', "today's spend limit was reached; it is tried again tomorrow");
      return res.outcome;
    }
    // Skipped (the site is off, renewing is switched off): the admin hears once per period.
    if ((verdict === 'skip_site_off' || verdict === 'skip_not_allowed') && r.autoRenewAlertedFor !== period) {
      await tell('skipped', verdict === 'skip_site_off' ? 'the website is not live' : 'renewing is switched off for this website');
    }
    return verdict;
  });
  // 7. The admin's Renew decisions.
  await each('renewDecisions', p.renewDecisions, async (r) => (await deps.engine.renew(r.id, {})).outcome);

  return { dry: false, ...summarise(p), outcomes, emails };
}
