import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { enqueueLeadDbPush, runLeadDbDelivery, type DeliveryRow, type FinishPatch, type LeadContext, type LeadDbDeps, type LeadDbStore } from './deliver.ts';
import { withoutCalculatorLeads } from './sweep.ts';
import type { WebsiteLeadBody } from './client.ts';

/**
 * Batch 55 (Part A), phase A6: a calculator site's lead is never an `si_website` push.
 * (Phase 2 sends it as `si_ad`.) A site-mode lead is unchanged: deliver.test.ts and hooks.test.ts still pass.
 */
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

const OWNER = '00000000-0000-4000-8000-000000000001';
const LEAD = '00000000-0000-4000-8000-0000000000aa';

function world(ctxOver: Partial<LeadContext>) {
  const enqueued: string[] = [];
  const finished: FinishPatch[] = [];
  const posts: WebsiteLeadBody[] = [];
  const ctx: LeadContext = {
    leadId: LEAD, ownerId: OWNER, status: 'new', archivedAt: null, name: 'Ann', email: 'ann@example.test', phone: '07700900123',
    address: '1 Test Road', postcode: 'LS1 1AA', bedrooms: 3, result: null, report: { state: 'awaiting_address', qualityOk: null }, ...ctxOver,
  };
  const row: DeliveryRow = { lead_id: LEAD, owner_id: OWNER, attempts: 0, lead_sent_at: null, report_sent_at: null, leaddb_lead_id: null };
  const store: LeadDbStore = {
    async claim() { return { ...row }; },
    async context() { return ctx; },
    async link() { return { ownerId: OWNER, status: 'active' }; },
    async finish(_id, patch) { finished.push(patch); },
    async linkResult() {},
    async due() { return []; },
    async enqueue(id) { enqueued.push(id); return 'inserted'; },
    async unqueued() { return []; },
    async reportsOwed() { return []; },
  };
  const deps: LeadDbDeps = {
    store,
    post: async (b) => { posts.push(b); return { ok: true, code: 'ok', retryable: false, status: 200, data: { ok: true, outcome: 'created', replayed: false, lead_id: 'x', url: 'u', report: 'coming' } }; },
    renderPdf: async () => null,
    now: () => new Date('2026-11-26T10:00:00Z'),
  };
  return { deps, enqueued, finished, posts };
}

test('enqueueLeadDbPush skips a calculator site lead: no row queued', async () => {
  const w = world({ calculator: true });
  assert.equal(await enqueueLeadDbPush(LEAD, w.deps), 'skipped');
  assert.deepEqual(w.enqueued, []);
  // The same lead on a normal site is queued, as before.
  const site = world({});
  assert.equal(await enqueueLeadDbPush(LEAD, site.deps), 'queued');
  assert.deepEqual(site.enqueued, [LEAD]);
});

test('a calculator lead queued by something else is never posted: the drain fails it for good with a code', async () => {
  const w = world({ calculator: true });
  const r = await runLeadDbDelivery(LEAD, w.deps);
  assert.deepEqual(r, { ok: false, code: 'calculator_site' });
  assert.equal(w.posts.length, 0, 'nothing is sent');
  assert.equal(w.finished.length, 1);
  assert.equal(w.finished[0].status, 'failed', 'not retryable: failed, visible to the admin by its code');
  assert.equal(w.finished[0].last_error, 'calculator_site');
});

test('the sweep drops calculator leads (pure) and keeps the order of the rest', () => {
  assert.deepEqual(withoutCalculatorLeads(['a', 'b', 'c', 'd'], new Set(['b', 'd'])), ['a', 'c']);
  assert.deepEqual(withoutCalculatorLeads(['a', 'b'], new Set()), ['a', 'b']);
  assert.deepEqual(withoutCalculatorLeads([], new Set(['a'])), []);
});

test('the real store reads the site mode into the context and the sweep filters by it', () => {
  const src = code(read('./store.ts'));
  assert.match(src, /select\('state, quality_ok, website_id'\)/);
  assert.match(src, /from\('websites'\)\.select\('mode'\)\.eq\('id', report\.website_id\)/);
  assert.match(src, /\.\.\.\(calculator \? \{ calculator: true \} : \{\}\)/);
  assert.match(src, /from\('website_reports'\)\.select\('lead_id, website_id'\)\.in\('lead_id', candidateIds\)/);
  assert.match(src, /from\('websites'\)\.select\('id'\)\.in\('id', siteIds\)\.eq\('mode', 'calculator'\)/);
  assert.match(src, /const websiteIds = withoutCalculatorLeads\(candidateIds, calculatorLeadIds\);/);
});

test('the hook call sites are unchanged and the push never writes leads.status or crm_pushed_at', () => {
  for (const f of ['./deliver.ts', './store.ts', './sweep.ts']) {
    const src = code(read(f));
    assert.doesNotMatch(src, /crm_pushed_at/, f);
    assert.doesNotMatch(src, /from\('leads'\)\s*\.update\(/, f);
  }
});
