import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Batch 31 phase 5: source pins for the website report run, in the repo's
 * source-pin style (the server code needs a database, so what is held here is
 * the shape of the code: who pays, what is charged when, what is emailed).
 */
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const report = read('./report-server.ts');
const store = read('./store-server.ts');
const notify = read('./notify-server.ts');
const leadsStore = read('../leads/store.ts');

/** Source with comments removed, so a rule about code is not satisfied (or broken) by prose. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

/** The text of a top-level function, up to the next top-level declaration. */
function fn(src: string, name: string): string {
  const m = new RegExp(`\\n(?:export )?(?:async )?function ${name}\\(`).exec(src);
  assert.ok(m, `${name} not found`);
  const rest = src.slice(m.index + 1);
  const next = rest.slice(10).search(/\n(?:export |async function |function |interface |type |const [A-Z_]+ =)/);
  return next < 0 ? rest : rest.slice(0, next + 10);
}

const run = code(report);

test('the free path passes billedUserId: null and carries no fixed price', () => {
  const opts = code(fn(report, 'runOptionsFor'));
  const [charged, free] = opts.split(' : ');
  assert.ok(free, 'a free arm after the charged arm');
  assert.match(free, /billedUserId:\s*null/);
  assert.doesNotMatch(free, /fixedPrice|reserveBasePence|ownerId/);
  assert.match(charged, /billingMode === 'charged'/);
  assert.match(charged, /fixedPrice:\s*true/);
  assert.match(charged, /reserveBasePence:/);
  // Both arms tag the funnel, so the run is a lead's.
  assert.match(free, /funnelId/);
  assert.match(charged, /funnelId/);
});

test('the run is made with those options, for both reserve and run', () => {
  assert.match(run, /const runOptions = runOptionsFor\(frozen, ctx\.ownerId, ctx\.funnelId\)/);
  assert.match(run, /reserveAnalysis\(runInput, runOptions\)/);
  assert.match(run, /runAnalysis\(prepared, runInput, \{ \.\.\.runOptions/);
  assert.equal((run.match(/billedUserId:/g) ?? []).length, 2, 'billedUserId is set in runOptionsFor only (one arm each)');
});

test('website_report_charge is named once, in chargeReport, and never with the run action id', () => {
  assert.equal((run.match(/website_report_charge/g) ?? []).length, 1);
  const charge = code(fn(report, 'chargeReport'));
  assert.match(charge, /rpc\('website_report_charge'/);
  assert.doesNotMatch(run, /actionId|action_id/);
});

test('the charge comes only after finish(), only for the charged mode with quality OK', () => {
  const finish = run.indexOf('prepared.finish({ completed: true })');
  const decide = run.indexOf('chargeDecision({');
  const call = run.indexOf('chargeReport(admin,');
  assert.ok(finish > 0 && decide > finish && call > decide, 'finish() then chargeDecision then chargeReport');
  assert.equal((run.match(/chargeReport\(admin,/g) ?? []).length, 1, 'one call site');
  // The decision reads the mode FROZEN on the report, the quality and the figures.
  const decision = run.slice(decide, call);
  assert.match(decision, /billingMode:\s*frozen\.billingMode/);
  assert.match(decision, /quality/);
  assert.match(decision, /hasFigures:\s*complete/);
  assert.match(run.slice(decide - 120, call + 60), /if \(charge\.charge\) await chargeReport/);
  // The quality is complete AND trustworthy, from the shared helpers.
  assert.match(run, /isTrustworthyReport\(/);
  assert.match(run, /analysisComplete\(result\)/);
  assert.match(run, /qualityOk\(\{ complete, trustworthy \}\)/);
});

test('nothing under src/lib/websites imports funnels/charge-server or funnels/tiers', () => {
  const bad = /(?:from|import|require)\s*\(?\s*['"][^'"]*funnels\/(?:charge-server|tiers)[^'"]*['"]/;
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
    });
  const files = walk(new URL('./', import.meta.url).pathname).filter((f) => !f.endsWith('.test.ts'));
  assert.ok(files.length >= 10);
  for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), bad, `${f} imports the funnel billing code`);
  for (const s of [report, store, notify]) assert.doesNotMatch(s, /charge-server|funnels\/tiers/);
});

test('completeLead is called with emailProspect: false', () => {
  const call = /completeLead\(\{[\s\S]*?\}\)/.exec(run);
  assert.ok(call, 'a completeLead call');
  assert.match(call[0], /emailProspect:\s*false/);
  assert.equal((run.match(/completeLead\(/g) ?? []).length, 1);
  // Before the state is stored done, and the landlord email goes after.
  assert.ok(run.indexOf('completeLead(') < run.indexOf("state: 'done'"));
  assert.ok(run.indexOf("state: 'done'") < run.indexOf("sendLandlordEmail({ leadId, kind: summary ? 'summary'"));
});

test('a website lead is never queued', () => {
  for (const s of [run, code(store), code(notify)]) {
    assert.doesNotMatch(s, /status:\s*['"]queued['"]/);
    assert.doesNotMatch(s, /releaseQueuedLead|leaseQueuedLead/);
  }
});

test('the lease is a conditional update, three attempts, then failed', () => {
  const lease = code(fn(report, 'takeLease'));
  assert.match(lease, /state: 'running'/);
  assert.match(lease, /lease_until/);
  assert.match(lease, /attempts: r\.attempts \+ 1/);
  assert.match(lease, /\.eq\('state', r\.state\)/);
  assert.match(lease, /\.eq\('attempts', r\.attempts\)/);
  assert.match(run, /staleLeaseAction\(report\.attempts\) === 'fail'/);
  assert.match(run, /attempt < MAX_REPORT_ATTEMPTS/);
  assert.match(code(fn(report, 'giveUp')), /state: 'failed'/);
  assert.match(code(fn(report, 'giveUp')), /sendLandlordEmail\(\{ leadId, kind: 'will_contact' \}\)/);
  assert.match(code(fn(report, 'giveUp')), /notifyOperatorReportFailed/);
});

test('step 2 follows policy: the frozen mode, the free claim, the balance check', () => {
  assert.match(run, /decideStep2\(/);
  assert.match(run, /freezeMode\(settings, existing\)/);
  assert.match(run, /rpc\('website_free_report_claim'/);
  assert.match(run, /claimOutcome\(claim\)/);
  assert.match(run, /faceAvailableFor\(ctx\.ownerId, 'website_report'\)/);
  // A self-submit held in free mode is held WITHOUT running: that branch returns before the lease.
  const hold = run.indexOf("decision.kind === 'hold'");
  const lease = run.indexOf('takeLease(admin, report');
  assert.ok(hold > 0 && lease > hold);
  assert.match(run.slice(hold, lease), /return stateOf\(/);
  // The day comes from the database.
  assert.match(code(fn(report, 'ukToday')), /rpc\('website_uk_day'/);
});

test('what comes back is a small state: no result and no address', () => {
  const state = code(report.slice(report.indexOf('export interface WebsiteReportState'), report.indexOf('interface ReportRow')));
  assert.doesNotMatch(state, /result|address|postcode/i);
  // The run's own lead rows are read for id/input only, and the summary is built from the allow-listed figures.
  assert.doesNotMatch(run, /select\('[^']*address[^']*'\)/);
  assert.match(run, /buildSummary\(/);
  // Logs carry the lead id and an error name, never the error text or a lead field.
  for (const m of run.matchAll(/console\.(?:error|warn|log)\(([^;]*)\);/g)) {
    assert.doesNotMatch(m[1], /address|postcode|email|phone|input|result/i, m[1]);
  }
});

test('the landlord is never sent a /r link or an address', () => {
  const n = code(notify);
  assert.doesNotMatch(n, /\/r\/|report_token|pdfUrl/);
  assert.doesNotMatch(n, /select\('[^']*(?:address|postcode)[^']*'\)/);
  assert.match(n, /website-summary/);
  assert.match(n, /brandedFrom\(process\.env\.EMAIL_FROM_WHITELABEL \|\| process\.env\.EMAIL_FROM, site\.company\)/);
  assert.match(n, /safeReplyTo\(site\.contactEmail\)/);
  assert.match(n, /owner_notified_at/);
  assert.match(n, /\/leads\/\$\{leadId\}/);
});

test('leads/store.ts: emailProspect defaults to true and only skips the prospect email', () => {
  assert.match(leadsStore, /emailProspect\?: boolean/);
  assert.match(leadsStore, /if \(input\.emailProspect !== false\) await emailReportToProspect\(input\.leadId\)/);
  // The CRM delivery and the status write are not conditional on it.
  assert.equal((leadsStore.match(/emailProspect/g) ?? []).length, 2);
});

test('the schema the run reads is the real one', () => {
  const schema = read('../../../supabase/schema.sql');
  for (const col of ['state', 'billing_mode', 'price_pence', 'due_day', 'lease_until', 'attempts', 'quality_ok', 'self_submit', 'completed_at']) {
    assert.match(schema, new RegExp(`website_reports[\\s\\S]*?\\b${col}\\b`));
  }
  assert.match(schema, /function public\.website_free_report_claim\(p_lead uuid, p_website uuid, p_held boolean/);
  assert.match(schema, /function public\.website_report_charge\(p jsonb\)/);
  assert.match(schema, /function public\.website_uk_day\(\)/);
});
