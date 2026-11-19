import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BTL_FORM_KEYS, validateBtlSettingsForm } from './admin-form.ts';
import { BTL_FINANCE_KEY, BTL_REPORT_PENCE_KEY, DEFAULT_BTL_SETTINGS, parseBtlFinance, parseBtlReportPence } from './config.ts';

/**
 * Review R4 (R4-31, Zac 19 Nov 2026): the buy-to-let settings form on /admin/deals/btl: the £2 report's price and the
 * finance, nothing else. The action is a SOURCE-TEXT PIN: it imports next/navigation and the Supabase server client.
 */

const read = (p: string) => readFileSync(new URL(p, import.meta.url).pathname, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const form = (o: Record<string, string>) => (name: string) => o[name] ?? null;
const good = { reportPence: '300', ltvPct: '70', stressAddPct: '2', stressFloorPct: '6', icrPct: '145', fallbackRatePct: '5.5' };

test('the form: a £3 report and 6% stress floor save as the readers read them; out of range saves nothing', () => {
  const r = validateBtlSettingsForm(form(good));
  assert.ok(r.ok);
  assert.equal(r.reportPence, 300);
  assert.deepEqual(r.finance, { ltvPct: 70, stressAddPct: 2, stressFloorPct: 6, icrPct: 145, fallbackRatePct: 5.5 });
  // What is saved reads back exactly (never silently as the default).
  assert.equal(parseBtlReportPence(r.reportPence), 300);
  assert.deepEqual(parseBtlFinance(r.finance), r.finance);
  for (const [field, bad] of [['reportPence', '2.5'], ['reportPence', '-1'], ['ltvPct', '96'], ['icrPct', '99'], ['stressFloorPct', ''], ['fallbackRatePct', 'abc']] as const) {
    const out = validateBtlSettingsForm(form({ ...good, [field]: bad }));
    assert.equal(out.ok, false, `${field}=${bad}`);
  }
  // The defaults round-trip.
  const d = DEFAULT_BTL_SETTINGS;
  assert.ok(validateBtlSettingsForm(form({ reportPence: String(d.reportPence), ...Object.fromEntries(Object.entries(d.finance).map(([k, v]) => [k, String(v)])) })).ok);
  assert.deepEqual([...BTL_FORM_KEYS], [BTL_REPORT_PENCE_KEY, BTL_FINANCE_KEY]);
});

test('the save action requires an admin, validates first, and writes only btl_report_pence and btl_finance', () => {
  const src = read('../../app/admin/deals/btl/actions.ts');
  assert.match(src, /^'use server';/m);
  const body = src.slice(src.indexOf('export async function saveBtlSettingsAction'));
  assert.ok(body.indexOf('await requireAdmin();') >= 0 && body.indexOf('await requireAdmin();') < body.indexOf('validateBtlSettingsForm('), 'the admin check comes first');
  assert.ok(body.indexOf('if (!r.ok) redirect(') < body.indexOf('updateBillingSetting('), 'nothing is saved on a bad field');
  const writes = [...body.matchAll(/updateBillingSetting\((\w+),/g)].map((m) => m[1]);
  assert.deepEqual(writes, ['BTL_REPORT_PENCE_KEY', 'BTL_FINANCE_KEY'], 'the two existing rows, nothing else');
  assert.match(src, /if \(!isAdminEmail\(user\.email\)\) notFound\(\);/);
  // The page's form posts to it; nothing on /admin/billing.
  assert.match(read('../../app/admin/deals/btl/page.tsx'), /<form action=\{saveBtlSettingsAction\}/);
});
