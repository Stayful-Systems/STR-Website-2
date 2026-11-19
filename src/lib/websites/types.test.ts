import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WEBSITE_STATUSES, REPORT_STATES, BILLING_MODES, CLAIM_RESULTS, CHARGE_RESULTS } from './types.ts';

const sql = readFileSync(new URL('../../../supabase/schema.sql', import.meta.url), 'utf8');
const section = sql.slice(sql.indexOf('-- Batch 31: customer websites'));

function listAfter(re: RegExp): string[] {
  const m = re.exec(section);
  assert.ok(m, `not found in schema: ${re}`);
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

test('the status, state and mode lists match the schema checks', () => {
  assert.deepEqual([...WEBSITE_STATUSES], listAfter(/websites_status_check check \(status in \(([^)]*)\)\)/));
  assert.deepEqual([...REPORT_STATES], listAfter(/website_reports_state_check\s+check \(state in \(([^)]*)\)\)/));
  assert.deepEqual([...BILLING_MODES], listAfter(/website_reports_billing_mode_check\s+check \(billing_mode is null or billing_mode in \(([^)]*)\)\)/));
  assert.deepEqual([...CHARGE_RESULTS].filter((r) => r !== 'already_charged'), listAfter(/website_report_charges_status_check check \(status in \(([^)]*)\)\)/));
});

test('the claim results are what website_free_report_claim returns', () => {
  for (const r of CLAIM_RESULTS) assert.ok(section.includes(`'${r}'`), r);
});
