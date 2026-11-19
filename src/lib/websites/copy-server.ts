import 'server-only';

/**
 * Batch 31: the AI first draft of a customer website's copy.
 *
 * One call per page (home, each area, fees, about, faq) to Sonnet 5.5 through
 * the knowledge job's callModel(), logged to provider_calls as house spend
 * (userId null: never debited, no per-member billing). Each reply is parsed
 * against the page's schema, then every string runs through checks.ts (copy-prompt
 * checkPageCopy); a reply that fails either is retried once with what was wrong
 * fed back, and a page that fails twice fails the whole draft. The assembled
 * copy is then run through buildSitePages and checkSite and any problem on a
 * page (not on the site's own settings) refuses it. Nothing is saved here: the
 * caller (the setup flow, Phase 10) keeps the copy.
 *
 * Regenerating is capped at WEBSITE_REGEN_CAP per site, counted on
 * websites.regen_count. The first draft does not count. The slot is taken
 * before any model call with a compare-and-set, so two clicks cannot both
 * pass at 9, and it is given back when the draft fails, so a failure never
 * uses up a regeneration.
 *
 * Privacy: neither the prompt nor the reply is logged, and neither goes to the
 * database here. A failure logs the page key, the rule ids and an error code,
 * never text. The prompt never holds contact details (copy-prompt.ts).
 */
import { createAdminClient } from '../supabase/admin';
import { getUnitCostTable } from '../credit/unit-costs';
import { unitKey } from '../credit/costs';
import { newActionId, type MeterContext } from '../credit/context';
import { GAP_DRAFT_MODEL } from '../knowledge/config';
import { callModel, modelsConfigured } from '../knowledge/gap/models-server';
import { unpricedUnits } from '../knowledge/gap/plan';
import {
  assembleCopy,
  buildCopyPrompt,
  checkPageCopy,
  parsePageCopy,
  type AboutCopy,
  type CopyPage,
  type FaqCopy,
  type FeesCopy,
  type HomeCopy,
  type PageCopy,
} from './copy-prompt';
import { checkSite } from './checks';
import { buildSitePages, listAreas, type SiteCopy, type SiteSettings } from './page-model';
import type { SiteRef } from './types';

/** How many times a site may be regenerated (the first draft is free). */
export const WEBSITE_REGEN_CAP = 10;
/** The model: the same Sonnet 5.5 the knowledge job drafts with. */
export const WEBSITE_COPY_MODEL = GAP_DRAFT_MODEL;
/** The provider_calls action every copy call is logged under. */
export const WEBSITE_COPY_ACTION = 'website_copy';
/** Pages written at the same time. */
const CONCURRENCY = 4;
/** One retry per page. */
const ATTEMPTS = 2;

type Admin = ReturnType<typeof createAdminClient>;

export type CopyFailure = 'cap' | 'not_found' | 'no_api_key' | 'model_error' | 'rejected';

export type CopyResult =
  | { ok: true; copy: SiteCopy; regenCount: number; costPence: number; calls: number }
  | { ok: false; reason: CopyFailure; message: string; regenCount: number | null; costPence: number; problems?: { page: string; field: string; rule: string }[] };

// ── The regeneration count ──

/** The site's regeneration count, or null when there is no such site. */
export async function regenCountOf(websiteId: string, admin: Admin = createAdminClient()): Promise<number | null> {
  const { data, error } = await admin.from('websites').select('regen_count').eq('id', websiteId).maybeSingle();
  if (error || !data) return null;
  return Number(data.regen_count) || 0;
}

/**
 * Take one regeneration: raises regen_count by one only while it is below the
 * cap, as a compare-and-set so concurrent calls cannot overshoot. Returns the
 * new count, 'cap' when none is left, or null when the site does not exist.
 */
export async function takeRegeneration(websiteId: string, admin: Admin = createAdminClient()): Promise<number | 'cap' | null> {
  for (let tries = 0; tries < 5; tries++) {
    const n = await regenCountOf(websiteId, admin);
    if (n === null) return null;
    if (n >= WEBSITE_REGEN_CAP) return 'cap';
    const { data, error } = await admin.from('websites').update({ regen_count: n + 1 }).eq('id', websiteId).eq('regen_count', n).select('regen_count');
    if (!error && data && data.length === 1) return n + 1;
  }
  return 'cap';
}

/** Give a taken regeneration back (a failed draft). Best effort: only if the count is still where it was left. */
async function giveBackRegeneration(websiteId: string, taken: number, admin: Admin): Promise<void> {
  await admin.from('websites').update({ regen_count: taken - 1 }).eq('id', websiteId).eq('regen_count', taken);
}

// ── One page ──

interface PageJob {
  page: CopyPage;
  areaName?: string;
}

interface PageOutcome {
  value: PageCopy | null;
  costPence: number;
  calls: number;
  error: string | null;
  problems: { page: string; field: string; rule: string }[];
}

/** An error code with no text from the request or reply in it. */
const codeOf = (e: string | null) => (e ?? 'unknown').split(':')[0].slice(0, 40);

async function writePage(job: PageJob, settings: SiteSettings, areas: string[], ctx: MeterContext, price: (unit: string) => number): Promise<PageOutcome> {
  let costPence = 0;
  let calls = 0;
  let problems: { field: string; rule: string; message: string }[] = [];
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const p = buildCopyPrompt({ page: job.page, companyName: settings.companyName, areas, areaName: job.areaName, aboutText: settings.aboutText, problems });
    const reply = await callModel({ model: WEBSITE_COPY_MODEL, system: p.system, cacheSystem: true, user: p.user, schema: p.schema, maxTokens: p.maxTokens, ctx, label: `website copy: ${job.page}`, price });
    calls++;
    costPence += reply.costPence;
    const parsed = reply.text ? parsePageCopy(job.page, reply.text) : null;
    if (!parsed || !parsed.ok) {
      lastError = reply.error ?? (parsed && !parsed.ok ? 'schema' : 'no_reply');
      problems = [{ field: 'reply', rule: 'schema', message: parsed && !parsed.ok ? parsed.error : 'the reply was empty' }];
      // A timeout, refusal or missing key will not mend on a second try with the same prompt.
      if (reply.error === 'no_api_key' || reply.error === 'refused') break;
      continue;
    }
    const found = checkPageCopy(job.page, parsed.value);
    if (found.length === 0) return { value: parsed.value, costPence, calls, error: null, problems: [] };
    lastError = 'checks';
    problems = found.map((f) => ({ field: f.field, rule: f.rule, message: f.message }));
  }
  return { value: null, costPence, calls, error: lastError, problems: problems.map((p) => ({ page: job.page, field: p.field, rule: p.rule })) };
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

// ── The draft ──

/**
 * Write (or rewrite) a site's copy. `kind: 'first'` is the first draft and
 * takes no regeneration; `'regenerate'` takes one, refused at the cap.
 */
export async function generateSiteCopy(o: { websiteId: string; site: SiteRef; settings: SiteSettings; kind: 'first' | 'regenerate' }): Promise<CopyResult> {
  const admin = createAdminClient();
  const fail = (reason: CopyFailure, message: string, regenCount: number | null, costPence = 0, problems?: { page: string; field: string; rule: string }[]): CopyResult => ({ ok: false, reason, message, regenCount, costPence, problems });

  if (!modelsConfigured()) return fail('no_api_key', 'The copy writer is not set up.', await regenCountOf(o.websiteId, admin));

  let taken: number | null = null;
  if (o.kind === 'regenerate') {
    const t = await takeRegeneration(o.websiteId, admin);
    if (t === null) return fail('not_found', 'No such site.', null);
    if (t === 'cap') return fail('cap', `You have used all ${WEBSITE_REGEN_CAP} rewrites for this site.`, WEBSITE_REGEN_CAP);
    taken = t;
  } else if ((await regenCountOf(o.websiteId, admin)) === null) {
    return fail('not_found', 'No such site.', null);
  }
  const countNow = async () => regenCountOf(o.websiteId, admin);
  const refund = async (reason: CopyFailure, message: string, costPence: number, problems?: { page: string; field: string; rule: string }[]): Promise<CopyResult> => {
    if (taken !== null) await giveBackRegeneration(o.websiteId, taken, admin);
    return fail(reason, message, await countNow(), costPence, problems);
  };

  // House-paid: provider_calls rows with no user, never a debit.
  const ctx: MeterContext = { userId: null, admin: false, action: WEBSITE_COPY_ACTION, actionId: newActionId() };
  const table = await getUnitCostTable();
  const price = (unit: string) => table.get(unitKey('anthropic', unit))?.unitCostPence ?? 0;
  if (unpricedUnits(price).length > 0) console.warn('[website-copy] some model units have no price: the spend will log at 0p');

  const areas = listAreas(o.settings.areas);
  const areaNames = areas.map((a) => a.name);
  const jobs: PageJob[] = [{ page: 'home' }, ...areas.map((a) => ({ page: 'area' as const, areaName: a.name })), { page: 'fees' }, { page: 'about' }, { page: 'faq' }];

  const outcomes = await pool(jobs, CONCURRENCY, (j) => writePage(j, o.settings, areaNames, ctx, price));
  const costPence = outcomes.reduce((n, r) => n + r.costPence, 0);
  const calls = outcomes.reduce((n, r) => n + r.calls, 0);

  const bad = outcomes.findIndex((r) => !r.value);
  if (bad >= 0) {
    const r = outcomes[bad];
    console.warn(`[website-copy] ${jobs[bad].page} page refused after ${ATTEMPTS} tries: ${codeOf(r.error)} ${r.problems.map((p) => `${p.field}/${p.rule}`).join(',').slice(0, 200)}`);
    const model = r.error !== 'checks' && r.error !== 'schema';
    return refund(model ? 'model_error' : 'rejected', 'The copy could not be written. Please try again.', costPence, r.problems);
  }

  const at = (page: CopyPage) => outcomes[jobs.findIndex((j) => j.page === page)].value;
  const copy = assembleCopy({
    home: at('home') as HomeCopy,
    areas: areas.map((a) => ({ area: a.name, copy: outcomes[jobs.findIndex((j) => j.page === 'area' && j.areaName === a.name)].value as { headline: string; body: string } })),
    fees: at('fees') as FeesCopy,
    about: at('about') as AboutCopy,
    faq: at('faq') as FaqCopy,
  });

  // The whole site as a visitor would read it. Problems with the member's own details (the site's details, the
  // fee line the settings supply, the privacy page's contact line) are theirs to fix, not the copy's.
  const result = checkSite(buildSitePages({ site: o.site, settings: o.settings, copy }));
  const mine = result.problems.filter((p) => p.page !== 'site' && p.page !== 'privacy' && p.field !== 'section:fee');
  if (mine.length) {
    console.warn(`[website-copy] assembled copy refused: ${mine.map((p) => `${p.page}/${p.field}/${p.rule}`).join(',').slice(0, 300)}`);
    return refund('rejected', 'The copy could not be written. Please try again.', costPence, mine.map((p) => ({ page: p.page, field: p.field, rule: p.rule })));
  }

  return { ok: true, copy, regenCount: (await countNow()) ?? taken ?? 0, costPence, calls };
}
