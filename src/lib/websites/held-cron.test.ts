import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Batch 31 phase 7: source pins for the held-report cron
 * (src/app/api/internal/website-reports/route.ts). The route needs a database,
 * so what is held here is the shape of the code: who may call it, what the dry
 * run is allowed to touch, the order the work runs in, and what it never imports.
 */
const routeSrc = readFileSync(new URL('../../app/api/internal/website-reports/route.ts', import.meta.url), 'utf8');
const vercel = JSON.parse(readFileSync(new URL('../../../vercel.json', import.meta.url), 'utf8')) as { crons: Array<{ path: string; schedule: string }> };

/** Source with comments removed, so a rule about code is not satisfied (or broken) by prose. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
const route = code(routeSrc);

/** The text of a top-level function, up to the next top-level declaration. */
function fn(src: string, name: string): string {
  const m = new RegExp(`\\n(?:export )?(?:async )?function ${name}\\(`).exec(src);
  assert.ok(m, `${name} not found`);
  const rest = src.slice(m.index + 1);
  const next = rest.slice(10).search(/\n(?:export |async function |function |interface |type |const [A-Z_]+ =)/);
  return next < 0 ? rest : rest.slice(0, next + 10);
}

test('the route is authorised like the other internal routes, before anything is read', () => {
  const get = fn(route, 'GET');
  assert.match(route, /import \{ authoriseInternal, internalSecretsConfigured \} from '@\/lib\/internal-auth'/);
  assert.match(get, /if \(!internalSecretsConfigured\(\)\) return new Response\('Not found', \{ status: 404 \}\)/);
  assert.match(get, /if \(!authoriseInternal\(request\)\) return new Response\('Unauthorised', \{ status: 401 \}\)/);
  assert.ok(get.indexOf('authoriseInternal(') < get.indexOf('createAdminClient()'));
  assert.match(routeSrc, /export const maxDuration = 60;/);
});

test('the dry run only reads: no report run, no lease, no write, no email', () => {
  const get = fn(route, 'GET');
  assert.match(get, /get\('dry'\) === '1'/);
  assert.match(get, /if \(dry\) return Response\.json\(await dryReport\(/);
  // The dry branch is dryReport and the helpers it calls.
  const dry = [fn(route, 'dryReport'), fn(route, 'dueHeldCap'), fn(route, 'waitingHeldCredit'), fn(route, 'staleRunning'), fn(route, 'expiryCount'), fn(route, 'slotsUsedToday'), fn(route, 'dueBacklog')].join('\n');
  assert.doesNotMatch(dry, /runWebsiteReport|runBatch|expireOld|emailBacklog|sendEmail/);
  assert.doesNotMatch(dry, /\.(update|insert|upsert|delete)\(/);
  assert.doesNotMatch(dry, /takeLease|leaseQueuedLead|attempts|lease_until:/);
  assert.doesNotMatch(dry, /\.rpc\(/);
  // The whole route reaches the database only through those reads, the UK-day read and the three writers.
  assert.equal((route.match(/\.update\(/g) ?? []).length, 1, 'one write: the 14-day expiry');
  assert.doesNotMatch(route, /\.(insert|upsert|delete)\(/);
  assert.equal((route.match(/\.rpc\(/g) ?? []).length, 1);
  assert.match(fn(route, 'ukToday'), /\.rpc\('website_uk_day'\)/);
  // What the dry run lists: counts and lead ids. No address, no contact, no result column is selected.
  assert.match(route, /const COLUMNS = 'lead_id, website_id'/);
  assert.doesNotMatch(route, /from\('leads'\)/);
  assert.doesNotMatch(route.replace(/awaiting_address/g, ''), /address|postcode|\.result\b/i);
});

test('held_cap runs first, then held_credit, then stale leases, then the expiry and the backlog email', () => {
  const run = fn(route, 'realRun');
  const at = (s: string) => {
    const i = run.indexOf(s);
    assert.ok(i >= 0, `${s} not in realRun`);
    return i;
  };
  assert.ok(at("runBatch('held_cap'") < at("runBatch('held_credit'"));
  assert.ok(at("runBatch('held_credit'") < at("runBatch('stale'"));
  assert.ok(at("runBatch('stale'") < at('expireOld('));
  assert.ok(at('expireOld(') < at('emailBacklog('));
  // Every report goes through runWebsiteReport, which does the claim, the balance check and the lease.
  assert.equal((route.match(/runWebsiteReport\(/g) ?? []).length, 1);
  assert.match(fn(route, 'runBatch'), /await runWebsiteReport\(row\.leadId\)/);
});

test('held_cap is oldest first and bounded; the batch is bounded; the run has a time budget', () => {
  assert.match(fn(route, 'dueHeldCap'), /\.eq\('state', 'held_cap'\)[\s\S]*\.lte\('due_day', f\.today\)[\s\S]*\.order\('created_at', \{ ascending: true \}\)[\s\S]*\.limit\(MAX_HELD_CAP_PER_RUN\)/);
  assert.match(route, /const MAX_HELD_CAP_PER_RUN = \d+;/);
  assert.match(route, /const MAX_HELD_CREDIT_PER_RUN = \d+;/);
  assert.match(route, /const MAX_STALE_PER_RUN = \d+;/);
  const budget = Number(/const START_BUDGET_MS = ([\d_]+);/.exec(route)?.[1].replace(/_/g, ''));
  assert.ok(budget > 0 && budget < 60_000, 'the start budget is under maxDuration (60 s)');
  assert.match(fn(route, 'runBatch'), /Date\.now\(\) - started > START_BUDGET_MS/);
  const emailBudget = Number(/const EMAIL_BUDGET_MS = ([\d_]+);/.exec(route)?.[1].replace(/_/g, ''));
  assert.ok(emailBudget > budget && emailBudget < 60_000);
});

test('a short balance is not looped on: a short owner is left alone for the rest of the run', () => {
  const batch = fn(route, 'runBatch');
  assert.match(batch, /shortSites/);
  assert.match(batch, /outcome === 'still_short'/);
  // held_credit is read by how long it has waited, and a retry that stays short moves to the back.
  assert.match(fn(route, 'waitingHeldCredit'), /\.eq\('state', 'held_credit'\)[\s\S]*\.order\('updated_at', \{ ascending: true \}\)/);
  // The route never reads a balance itself: runWebsiteReport rechecks.
  assert.doesNotMatch(route, /getBalance|faceAvailableFor|credit\/ledger/);
});

test('stale leases: running with lease_until in the past, and a report already tried this run is left', () => {
  assert.match(fn(route, 'staleRunning'), /\.eq\('state', 'running'\)[\s\S]*lease_until\.is\.null,lease_until\.lt\./);
  assert.match(fn(route, 'realRun'), /tried = new Set\(tally\.outcomes\.map/);
});

test('reports expire after 14 days, never delete, and the lead is not touched', () => {
  assert.match(route, /const EXPIRE_AFTER_DAYS = 14;/);
  assert.match(route, /const EXPIRABLE_STATES = \['awaiting_address', 'held_cap', 'held_credit', 'held_self'\] as const;/);
  const expire = fn(route, 'expireOld');
  assert.match(expire, /state: 'expired'/);
  assert.match(expire, /\.in\('state', \[\.\.\.EXPIRABLE_STATES\]\)/);
  assert.match(expire, /\.lt\('created_at', f\.cutoff\)/);
  assert.doesNotMatch(route, /\.delete\(/);
  assert.doesNotMatch(route, /from\('leads'\)/);
  // Reports that old are not run (and so not charged or spent on) in steps 1 and 2.
  assert.match(fn(route, 'dueHeldCap'), /\.gte\('created_at', f\.cutoff\)/);
  assert.match(fn(route, 'waitingHeldCredit'), /\.gte\('created_at', f\.cutoff\)/);
  // running is never expired here: a stale lease goes through runWebsiteReport's three attempts.
  assert.doesNotMatch(/EXPIRABLE_STATES = \[[^\]]*\]/.exec(route)?.[0] ?? '', /running|done|failed/);
});

test('the admin backlog email is one a UK day, keyed by the day, with no personal data', () => {
  assert.match(fn(route, 'emailBacklog'), /idempotencyKey: `website-backlog:\$\{day\}`/);
  assert.match(fn(route, 'realRun'), /backlog > f\.dailyCap/);
  assert.match(route, /adminEmails\(\)\[0\]/);
  const body = fn(route, 'backlogEmail');
  assert.doesNotMatch(body, /leadId|lead_id|address|postcode|landlord/i);
  // The email function takes a day and two counts, nothing else.
  assert.match(body, /function backlogEmail\(day: string, due: number, cap: number\)/);
});

test('one report failing never ends the run, and logs carry lead ids and error names only', () => {
  const batch = fn(route, 'runBatch');
  assert.match(batch, /try \{[\s\S]*await runWebsiteReport[\s\S]*\} catch \(err\)/);
  assert.match(batch, /err instanceof Error \? err\.name : 'error'/);
  assert.match(fn(route, 'GET'), /catch \(err\)[\s\S]*err instanceof Error \? err\.name/);
  // No log line prints an error's text from a report run (only the database's own message for a read).
  for (const line of route.split('\n').filter((l) => /console\.error\(/.test(l))) {
    if (/err\.message/.test(line)) assert.fail(`a log line prints an error's text: ${line.trim()}`);
  }
});

test('the cron never touches the funnel queue: a website lead is never queued', () => {
  assert.doesNotMatch(route, /queued|releaseQueuedLead|leaseQueuedLead|funnel-queue/);
  // And nothing under src/lib/websites or src/app/api/s sets or leases the status the funnel-queue cron reads.
  const roots = [fileURLToPath(new URL('.', import.meta.url)), fileURLToPath(new URL('../../app/api/s', import.meta.url))];
  const files: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name) && !/\.test\.ts$/.test(name)) files.push(p);
    }
  };
  roots.forEach(walk);
  assert.ok(files.length > 10);
  for (const f of files) {
    const s = code(readFileSync(f, 'utf8'));
    assert.doesNotMatch(s, /releaseQueuedLead|leaseQueuedLead/, f);
    assert.doesNotMatch(s, /status:\s*['"]queued['"]/, f);
  }
});

test('the cron does not import charge-server or tiers', () => {
  assert.doesNotMatch(routeSrc, /funnels\/charge-server|funnels\/tiers|charge-server|tiers/);
  assert.doesNotMatch(routeSrc, /website_report_charge/, 'charging stays in runWebsiteReport');
});

test('vercel.json declares one hourly cron for the route', () => {
  const entries = vercel.crons.filter((c) => c.path === '/api/internal/website-reports');
  assert.equal(entries.length, 1);
  // Minute fixed, every other field a star: once an hour.
  assert.match(entries[0].schedule, /^\d{1,2} \* \* \* \*$/);
});
