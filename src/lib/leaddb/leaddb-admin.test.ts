import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SEED } from '../knowledge/seed.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('admin: every action checks the admin; the dry run only reads', () => {
  const src = code(read('../../app/admin/management/leaddb-admin-actions.ts'));
  assert.equal((src.match(/await requireAdmin\(\)/g) ?? []).length, 2);
  const dry = src.slice(src.indexOf('export async function dryRunLeadDbRetryAction'), src.indexOf('export async function leadDbRetryAction'));
  assert.match(dry, /leadDbRetryPreview/);
  assert.doesNotMatch(dry, /leadDbRetry\(|\.update\(|\.insert\(|\.upsert\(|\.rpc\(/);
  // The real retry re-runs the preview's refusals before it resets anything.
  const real = src.slice(src.indexOf('export async function leadDbRetryAction'));
  assert.ok(real.indexOf('leadDbRetryPreview') < real.indexOf('leadDbRetry(leadId)'));
});

test('admin: the preview reads only, and the retry resets one failed or pending row', () => {
  const store = code(read('./store.ts'));
  const preview = store.slice(store.indexOf('export async function leadDbRetryPreview'), store.indexOf('export async function leadDbRetry('));
  assert.doesNotMatch(preview, /\.update\(|\.insert\(|\.upsert\(|\.delete\(|\.rpc\(/);
  const retry = store.slice(store.indexOf('export async function leadDbRetry('));
  assert.match(retry, /\.eq\('lead_id', leadId\)/);
  assert.match(retry, /\.in\('status', \['pending', 'failed'\]\)/);
});

test('admin: the panel shows ids, owner, the error and attempts, and no landlord details', () => {
  const panel = read('../../app/admin/management/LeadDbFailuresPanel.tsx');
  for (const col of ['Lead', 'Owner', 'Problem', 'Attempts']) assert.ok(panel.includes(col), col);
  const store = code(read('./store.ts'));
  const list = store.slice(store.indexOf('export async function leadDbProblems'), store.indexOf('export async function leadDbRetryPreview'));
  assert.doesNotMatch(list, /name|phone|address|postcode/);
  assert.match(read('../../app/admin/management/page.tsx'), /<LeadDbFailuresPanel \/>/);
});

test('knowledge: the four Batch 32 entries are seeded as drafts, with no typed figure', () => {
  const slugs = ['leaddb_website_leads', 'leaddb_not_charged', 'leaddb_no_account', 'leaddb_report_coming'];
  for (const slug of slugs) {
    const e = SEED.find((x) => x.slug === slug);
    assert.ok(e, slug);
    assert.doesNotMatch(e.answer, /£|\d/, `${slug} types a figure`);
  }
  assert.equal(SEED.find((x) => x.slug === 'leaddb_website_leads')?.question, 'Can my website leads go into my lead database?');
  assert.equal(SEED.find((x) => x.slug === 'leaddb_not_charged')?.question, 'Am I charged again in the lead database?');
  assert.equal(SEED.find((x) => x.slug === 'leaddb_no_account')?.question, 'I don’t have a lead database account');
  assert.equal(SEED.find((x) => x.slug === 'leaddb_report_coming')?.question, 'Why does it say Report coming?');
  // Nothing in the seed approves itself.
  assert.doesNotMatch(read('../knowledge/seed.ts'), /approved:\s*true/);
});
