import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { CALCULATOR_DAY_FULL_MESSAGE, calculatorDayDecision, ukDayWindow } from './calculator-limit.ts';
import { CALCULATOR_BILLING } from './calculator.ts';

/**
 * Batch 55 (Part A), phase A6: the report flow for calculator sites. The routes and the report run need a database,
 * so what is held here is the pure decision plus the shape of the code (source pins).
 */
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

const lead = code(read('../../app/api/s/[slug]/lead/route.ts'));
const report = code(read('../../app/api/s/[slug]/report/route.ts'));
const auto = code(read('../../app/api/address-autocomplete/route.ts'));
const runner = code(read('./report-server.ts'));
const cronRoute = code(read('../../app/api/internal/website-reports/route.ts'));
const gate = code(read('./calculator-server.ts'));

// ── The daily limit: the pure decision ──

test('a limit of 50: the 50th lead is allowed, the 51st is refused', () => {
  assert.deepEqual(calculatorDayDecision({ limit: 50, usedToday: 49 }), { allowed: true });
  assert.deepEqual(calculatorDayDecision({ limit: 50, usedToday: 50 }), { allowed: false, reason: 'day_full' });
  assert.deepEqual(calculatorDayDecision({ limit: 50, usedToday: 51 }), { allowed: false, reason: 'day_full' });
  assert.deepEqual(calculatorDayDecision({ limit: 50, usedToday: 0 }), { allowed: true });
});

test('a limit of 0 (or nonsense) allows none; a bad count reads as none used', () => {
  for (const limit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(calculatorDayDecision({ limit, usedToday: 0 }), { allowed: false, reason: 'none_allowed' }, String(limit));
  }
  assert.deepEqual(calculatorDayDecision({ limit: 5, usedToday: Number.NaN }), { allowed: true });
  assert.deepEqual(calculatorDayDecision({ limit: 5, usedToday: -3 }), { allowed: true });
  assert.deepEqual(calculatorDayDecision({ limit: 1, usedToday: 0 }), { allowed: true });
  assert.deepEqual(calculatorDayDecision({ limit: 1, usedToday: 1 }), { allowed: false, reason: 'day_full' });
});

test('the refusal is neutral plain English with no figure', () => {
  assert.match(CALCULATOR_DAY_FULL_MESSAGE, /try again tomorrow/i);
  assert.doesNotMatch(CALCULATOR_DAY_FULL_MESSAGE, /\d|!|limit|50/);
});

// ── The UK day window ──

test('the UK day: winter is UTC, summer starts an hour earlier in UTC', () => {
  const w = ukDayWindow(new Date('2026-12-10T15:30:00Z'));
  assert.deepEqual(w, { day: '2026-12-10', startIso: '2026-12-10T00:00:00.000Z', endIso: '2026-12-11T00:00:00.000Z' });
  const s = ukDayWindow(new Date('2026-07-10T15:30:00Z'));
  assert.deepEqual(s, { day: '2026-07-10', startIso: '2026-07-09T23:00:00.000Z', endIso: '2026-07-10T23:00:00.000Z' });
});

test('the UK day: 23:30 UTC in summer is already the next London day, and 00:30 UTC is still the day before', () => {
  assert.equal(ukDayWindow(new Date('2026-07-10T23:30:00Z')).day, '2026-07-11');
  assert.equal(ukDayWindow(new Date('2026-07-10T22:59:59Z')).day, '2026-07-10');
  assert.equal(ukDayWindow(new Date('2026-07-10T23:00:00Z')).day, '2026-07-11');
  assert.equal(ukDayWindow(new Date('2026-12-10T00:00:00Z')).day, '2026-12-10');
});

test('the UK day on the clock-change days is 23 and 25 hours long', () => {
  const hours = (w: { startIso: string; endIso: string }) => (Date.parse(w.endIso) - Date.parse(w.startIso)) / 3_600_000;
  assert.equal(hours(ukDayWindow(new Date('2026-03-29T12:00:00Z'))), 23); // clocks go forward
  assert.equal(hours(ukDayWindow(new Date('2026-10-25T12:00:00Z'))), 25); // clocks go back
  assert.equal(hours(ukDayWindow(new Date('2026-06-01T12:00:00Z'))), 24);
  // Windows tile: the end of one day is the start of the next, across a month and a year end.
  assert.equal(ukDayWindow(new Date('2026-12-31T12:00:00Z')).endIso, ukDayWindow(new Date('2027-01-01T12:00:00Z')).startIso);
  assert.equal(ukDayWindow(new Date('2026-07-31T12:00:00Z')).endIso, ukDayWindow(new Date('2026-08-01T12:00:00Z')).startIso);
});

// ── The step-1 lead route ──

test('the lead route: the stop rule comes right after the live-site check, before Turnstile', () => {
  const at = (n: string) => {
    const i = lead.indexOf(n);
    assert.ok(i >= 0, n);
    return i;
  };
  assert.match(lead, /import \{ calculatorStopped \} from '@\/lib\/websites\/calculator-server';/);
  assert.match(lead, /if \(await calculatorStopped\(site\)\) return new Response\('Not found', \{ status: 404 \}\);/);
  assert.ok(at('liveSiteBySlug(slug)') < at('calculatorStopped(site)'));
  assert.ok(at('calculatorStopped(site)') < at('verifyTurnstile('));
});

test('the lead route: the daily limit is read and counted BEFORE the lead is created, and a refusal makes no lead row', () => {
  const at = (n: string) => {
    const i = lead.indexOf(n);
    assert.ok(i >= 0, n);
    return i;
  };
  assert.match(lead, /if \(isCalculatorMode\(site\.mode\)\) \{/);
  assert.match(lead, /\.eq\('user_id', site\.userId\)\s*\.eq\('funnel_id', site\.funnelId\)\s*\.gte\('created_at', window\.startIso\)\s*\.lt\('created_at', window\.endIso\)/);
  assert.match(lead, /calculatorDayDecision\(\{ limit: await readAdCalcReportsPerDay\(\), usedToday: count \?\? 0 \}\)/);
  assert.match(lead, /if \(!day\.allowed\) return reply\(\{ ok: false, error: CALCULATOR_DAY_FULL_MESSAGE \}, 429\);/);
  assert.ok(at('calculatorDayDecision(') < at('captureLead({'), 'refused before captureLead: no lead row');
  assert.ok(at('validateStepOne(') < at('calculatorDayDecision('));
  // Only a NEW lead is counted: the same enquiry inside the hour reuses its lead and is never refused.
  assert.ok(at('if (prior) leadId') < at('calculatorDayDecision('));
  assert.ok(at('if (!leadId) {') < at('calculatorDayDecision('));
  // Nothing after the refusal can write a lead, a source or a report row.
  const refusal = lead.slice(at('calculatorDayDecision('), at('captureLead({'));
  assert.doesNotMatch(refusal, /\.insert\(|\.upsert\(|\.update\(/);
});

test('the lead route: a failed count refuses too (fails closed) and logs a code only', () => {
  assert.match(lead, /if \(countError\) \{\s*console\.error\(`\[website-lead\] daily count failed for website \$\{site\.id\}:`, countError\.code \?\? 'error'\);\s*return reply\(\{ ok: false, error: SAVE_FAILED \}, 503\);/);
});

test('the limit is read from the setting and a site-mode lead never reaches the counting branch', () => {
  assert.match(lead, /import \{ readAdCalcReportsPerDay \} from '@\/lib\/websites\/calc-settings-server';/);
  const branch = lead.slice(lead.indexOf('if (isCalculatorMode(site.mode)) {'), lead.indexOf('captureLead({'));
  assert.match(branch, /readAdCalcReportsPerDay\(\)/);
  assert.equal((lead.match(/readAdCalcReportsPerDay\(\)/g) ?? []).length, 1);
});

// ── The other two public requests ──

test('the report-request route stops a calculator site only where a NEW report would start', () => {
  assert.match(report, /import \{ calculatorStopped \} from '@\/lib\/websites\/calculator-server';/);
  assert.equal((report.match(/calculatorStopped\(site\)/g) ?? []).length, 1);
  const at = (n: string) => report.indexOf(n);
  // After the "not awaiting its address" answer (a running or done report is only read back), before the address is saved and the run starts.
  assert.ok(at("if (current.state !== 'awaiting_address')") < at('calculatorStopped(site)'));
  assert.ok(at('calculatorStopped(site)') < at('runWebsiteReport('));
  assert.ok(at('calculatorStopped(site)') < at(".update({\n      address:"));
  assert.match(report, /if \(await calculatorStopped\(site\)\) return new Response\('Not found', \{ status: 404 \}\);/);
});

test('address-autocomplete: a stopped calculator site gets no suggestions, as an unknown slug does', () => {
  assert.match(auto, /import \{ calculatorStopped \} from '@\/lib\/websites\/calculator-server';/);
  const branch = auto.slice(auto.indexOf('} else if (siteSlug) {'), auto.indexOf('} else {\n    try {\n      const supabase'));
  assert.match(branch, /if \(await calculatorStopped\(site\)\) return Response\.json\(\{ suggestions: \[\] \}\);/);
  assert.ok(branch.indexOf('liveSiteBySlug(siteSlug)') < branch.indexOf('calculatorStopped(site)'));
  assert.ok(branch.indexOf('calculatorStopped(site)') < branch.indexOf('countAutocomplete('));
});

test('the stop check: only calculator sites, through calculatorServes and the real account read, failing closed', () => {
  assert.match(gate, /if \(!isCalculatorMode\(site\.mode\)\) return false;/);
  assert.match(gate, /readAdAccount\(site\.userId\)/);
  assert.match(gate, /return !calculatorServes\(site, account, new Date\(\)\);/);
  assert.ok(gate.indexOf('isCalculatorMode(') < gate.indexOf('readAdAccount('), 'a normal site never reads the ad account');
});

// ── The running report is never cut off ──

test('the report run and the cron never use the stop check, the ad account or the public lookup', () => {
  for (const [name, src] of Object.entries({ 'report-server.ts': runner, 'website-reports route': cronRoute })) {
    assert.doesNotMatch(src, /calculatorStopped|calculator-server|calculatorServes|adRouteStopped|readAdAccount|ad-account|liveSiteBySlug/, name);
  }
});

// ── The report flow: calculator mode ──

test('calculator reports run free at 0p, house-paid, and the frozen mode is what a calculator site gets', () => {
  assert.deepEqual(CALCULATOR_BILLING, { billingMode: 'free', pricePence: 0 });
  assert.match(runner, /const calculator = isCalculatorMode\(ctx\.siteMode\);/);
  assert.match(runner, /if \(calculator\) \{[^}]*frozen = CALCULATOR_BILLING;\s*\} else \{/);
});

test('report-server: the free claim, held_cap, decideStep2 and held_credit sit only in the site-mode branch', () => {
  const start = runner.indexOf('if (calculator) {');
  const elseAt = runner.indexOf('} else {', start);
  assert.ok(start > 0 && elseAt > start);
  const calcBranch = runner.slice(start, elseAt);
  assert.doesNotMatch(calcBranch, /website_free_report_claim|decideStep2|claimOutcome|held_cap|held_credit|held_self|hold\(|freezeMode|faceAvailableFor|chargeReport|chargeDecision/);
  // Every one of them still exists, after the else (site mode is unchanged).
  const rest = runner.slice(elseAt);
  for (const needle of ['website_free_report_claim', 'decideStep2(', 'claimOutcome(', 'faceAvailableFor(', 'freezeMode(', 'hold(admin, report, decision.state']) {
    assert.ok(rest.includes(needle), needle);
  }
});

test('report-server: a calculator report is never charged, and a credit shortfall never holds it', () => {
  assert.match(runner, /const charge = calculator \? \(\{ charge: false, reason: 'free_mode' \} as const\) : chargeDecision\(/);
  assert.match(runner, /err instanceof InsufficientCreditError && !calculator/);
  // chargeReport is called once, only behind that decision.
  assert.equal((runner.match(/await chargeReport\(/g) ?? []).length, 1);
  assert.match(runner, /if \(charge\.charge\) await chargeReport\(/);
  // The run is house-paid in free mode, so a calculator run bills nobody.
  assert.match(runner, /: \{ billedUserId: null, funnelId \}/);
});

test('report-server reads the site mode with the site, and still hooks the lead database push once', () => {
  assert.match(runner, /select\('user_id, funnel_id, mode'\)/);
  assert.equal((runner.match(/enqueueLeadDbPush\(/g) ?? []).length, 1);
});

test('the site-mode report path is untouched: it still holds for the cap, the credit and a self-submit', () => {
  const site = runner.slice(runner.indexOf('} else {', runner.indexOf('if (calculator) {')));
  for (const needle of ["kind: 'will_contact'", "kind: 'held'", 'readWebsiteSettings()', 'claimOutcome(claim)', 'nextDay(today)']) assert.ok(site.includes(needle), needle);
});

test('this phase adds no migration and writes no leads.status or crm_pushed_at', () => {
  for (const [name, src] of Object.entries({ lead, report, runner, gate, limit: code(read('./calculator-limit.ts')) })) {
    assert.doesNotMatch(src, /crm_pushed_at/, name);
  }
  assert.ok(existsSync(new URL('./calculator-limit.ts', import.meta.url)));
});
