import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  runLeadDbDelivery, enqueueLeadDbPush, sweepLeadDbDeliveries, drainLeadDbDeliveries,
  type DeliveryRow, type FinishPatch, type LeadContext, type LeadDbDeps, type LeadDbStore, type LinkState,
} from './deliver.ts';
import type { LeadDbResult, WebsiteLeadBody, WebsiteLeadReply } from './client.ts';
import type { AnalysisResult } from '../types.ts';

const ADDRESS = '12 Acacia Road, Leeds';
const OWNER = '00000000-0000-4000-8000-000000000001';
const LEAD = '00000000-0000-4000-8000-0000000000aa';
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]);

const result = {
  property: { bedrooms: 3 },
  shortLet: { annualRevenue: 41980, occupancyRate: 0.71, averageDailyRate: 160.4 },
} as unknown as AnalysisResult;

interface Row extends DeliveryRow { status: 'pending' | 'sent' | 'failed'; next_attempt_at: string; lease_until: string | null; last_error: string | null; outcome: string | null; created_at: string }

function world(over: { ctx?: Partial<LeadContext>; link?: LinkState | null; reportState?: string } = {}) {
  const clock = { t: Date.parse('2026-11-20T10:00:00Z') };
  const rows = new Map<string, Row>();
  const posts: WebsiteLeadBody[] = [];
  const linkCalls: unknown[] = [];
  let ctx: LeadContext = {
    leadId: LEAD, ownerId: OWNER, status: 'new', archivedAt: null, name: 'Ann', email: 'ann@example.test', phone: '07700900123',
    address: ADDRESS, postcode: 'LS1 1AA', bedrooms: 3, result,
    report: { state: over.reportState ?? 'awaiting_address', qualityOk: true }, ...over.ctx,
  };
  let link: LinkState | null = over.link === undefined ? { ownerId: OWNER, status: 'active' } : over.link;
  const store: LeadDbStore = {
    async claim(id, nowIso, leaseIso) {
      const r = rows.get(id);
      if (!r || r.status !== 'pending' || r.next_attempt_at > nowIso || (r.lease_until && r.lease_until >= nowIso)) return null;
      r.lease_until = leaseIso;
      return { ...r };
    },
    async context() { return ctx; },
    async link() { return link; },
    async finish(id, patch: FinishPatch, attempts) {
      const r = rows.get(id)!;
      if (r.attempts !== attempts) return;
      Object.assign(r, patch, { lease_until: null });
    },
    async linkResult(_o, res) { linkCalls.push(res); },
    async due(limit, nowIso) { return [...rows.values()].filter((r) => r.status === 'pending' && r.next_attempt_at <= nowIso).slice(0, limit); },
    async enqueue(id, owner, opts) {
      const r = rows.get(id);
      if (!r) {
        rows.set(id, { lead_id: id, owner_id: owner, attempts: 0, lead_sent_at: null, report_sent_at: null, leaddb_lead_id: null, status: 'pending', next_attempt_at: new Date(clock.t).toISOString(), lease_until: null, last_error: null, outcome: null, created_at: new Date(clock.t).toISOString() });
        return 'inserted';
      }
      if (opts.reportDone && r.status === 'sent' && r.report_sent_at === null) {
        Object.assign(r, { status: 'pending', attempts: 0, next_attempt_at: new Date(clock.t).toISOString(), last_error: null });
        return 'repended';
      }
      return 'exists';
    },
    async unqueued() { return rows.has(LEAD) ? [] : [{ leadId: LEAD, ownerId: OWNER }]; },
    async reportsOwed() {
      return [...rows.values()].filter((r) => r.status === 'sent' && r.report_sent_at === null && r.last_error === null && ctx.report?.state === 'done').map((r) => ({ leadId: r.lead_id, ownerId: r.owner_id }));
    },
  };
  let responder: (b: WebsiteLeadBody) => LeadDbResult<WebsiteLeadReply> = (b) => ({
    ok: true, code: 'ok', retryable: false, status: 200,
    data: { ok: true, outcome: 'created', replayed: false, lead_id: 'ldb-1', url: 'https://leads.example.test/x', report: b.report ? 'attached' : 'coming' },
  });
  const deps: LeadDbDeps = {
    store,
    post: async (b) => { posts.push(JSON.parse(JSON.stringify(b))); return responder(b); },
    renderPdf: async () => PDF,
    now: () => new Date(clock.t),
  };
  return {
    deps, rows, posts, linkCalls, clock,
    setResponder(f: typeof responder) { responder = f; },
    setCtx(p: Partial<LeadContext>) { ctx = { ...ctx, ...p }; },
    setLink(l: LinkState | null) { link = l; },
    row: () => rows.get(LEAD)!,
  };
}

const fail = (code: string, retryable: boolean): LeadDbResult<WebsiteLeadReply> => ({ ok: false, code, retryable, status: 0 });

test('3 retries (two failing, then ok) keep ONE SI lead id and ONE leaddb lead id', async () => {
  const w = world();
  let n = 0;
  w.setResponder(() => (++n < 3 ? fail('network', true) : { ok: true, code: 'ok', retryable: false, status: 200, data: { ok: true, outcome: 'created', replayed: n > 3, lead_id: 'ldb-1', url: 'u', report: 'coming' } }));
  await w.deps.store.enqueue(LEAD, OWNER, { reportDone: false });
  for (let i = 0; i < 3; i++) {
    const r = await runLeadDbDelivery(LEAD, w.deps);
    assert.ok(r);
    w.clock.t += 61 * 60_000; // past any backoff
  }
  assert.equal(w.posts.length, 3);
  assert.deepEqual([...new Set(w.posts.map((p) => p.si_lead_id))], [LEAD]);
  assert.equal(w.row().status, 'sent');
  assert.equal(w.row().leaddb_lead_id, 'ldb-1');
  assert.equal(w.row().attempts, 3);
  assert.ok(w.row().lead_sent_at);
  assert.equal(w.row().report_sent_at, null);
  assert.equal(w.posts[0].report, undefined, 'step 1: lead only, report coming');
});

test('a held lead is skipped: nothing is sent and no attempt is used', async () => {
  const w = world({ ctx: { status: 'held' } });
  await w.deps.store.enqueue(LEAD, OWNER, { reportDone: false });
  const r = await runLeadDbDelivery(LEAD, w.deps);
  assert.deepEqual(r, { ok: true, code: 'held' });
  assert.equal(w.posts.length, 0);
  assert.equal(w.row().attempts, 0);
  assert.equal(w.row().status, 'pending');
  // And enqueue itself refuses a held lead.
  const w2 = world({ ctx: { status: 'held' } });
  assert.equal(await enqueueLeadDbPush(LEAD, w2.deps), 'skipped');
  assert.equal(w2.rows.size, 0);
});

test('the report attaches on a later run, to the same lead, once', async () => {
  const w = world();
  await w.deps.store.enqueue(LEAD, OWNER, { reportDone: false });
  await runLeadDbDelivery(LEAD, w.deps);
  assert.equal(w.row().status, 'sent');
  assert.equal(w.row().report_sent_at, null);

  w.setCtx({ report: { state: 'done', qualityOk: true } });
  assert.equal(await enqueueLeadDbPush(LEAD, w.deps), 'queued');
  assert.equal(w.row().status, 'pending', 'the done report re-pends a sent row');
  await runLeadDbDelivery(LEAD, w.deps);

  assert.equal(w.posts.length, 2);
  assert.equal(w.posts[1].si_lead_id, LEAD);
  assert.deepEqual(
    { ...w.posts[1].report, pdf_base64: '…' },
    { gross_annual_income: 41980, nightly_rate: 160, occupancy_pct: 71, bedrooms: 3, pdf_base64: '…' },
  );
  assert.equal(w.row().status, 'sent');
  assert.ok(w.row().report_sent_at);
  // Done: neither the sweep nor another enqueue sends it a third time.
  assert.equal((await sweepLeadDbDeliveries(10, {}, w.deps)).enqueued, 0);
  await enqueueLeadDbPush(LEAD, w.deps);
  assert.equal(w.row().status, 'sent');
});

test('a PDF that will not render sends the lead alone and keeps the report owed (retried, bounded)', async () => {
  const w = world({ reportState: 'done' });
  w.deps.renderPdf = async () => { throw new Error('boom'); };
  await w.deps.store.enqueue(LEAD, OWNER, { reportDone: true });
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
  try { await runLeadDbDelivery(LEAD, w.deps); } finally { console.error = orig; }
  assert.equal(w.posts[0].report, undefined);
  assert.equal(w.row().status, 'pending');
  assert.equal(w.row().last_error, 'report_not_sent');
  assert.ok(w.row().lead_sent_at);
  assert.ok(!logged.join('\n').includes('boom'), 'only an id is logged, not the error text');
});

test('a report the receiver refuses (bad_report) does not cost the lead: it is re-sent alone, report left owed', async () => {
  const w = world({ reportState: 'done' });
  w.setResponder((b) => (b.report
    ? { ok: false, code: 'bad_report', retryable: false, status: 422 }
    : { ok: true, code: 'ok', retryable: false, status: 200, data: { ok: true, outcome: 'created', replayed: false, lead_id: 'ldb-1', url: 'u', report: 'coming' } }));
  await w.deps.store.enqueue(LEAD, OWNER, { reportDone: true });
  await runLeadDbDelivery(LEAD, w.deps);
  assert.equal(w.posts.length, 2);
  assert.ok(w.posts[0].report, 'first try carried the report');
  assert.equal(w.posts[1].report, undefined, 'second try is the lead alone');
  assert.equal(w.row().leaddb_lead_id, 'ldb-1');
  assert.ok(w.row().lead_sent_at);
  assert.equal(w.row().report_sent_at, null);
  assert.equal(w.row().status, 'pending');
  assert.equal(w.row().last_error, 'report_not_sent');
});

test('a report that finished with no figures is not owed for ever', async () => {
  const w = world({ reportState: 'done', ctx: { result: { property: { bedrooms: 3 }, shortLet: { annualRevenue: 0 } } as unknown as AnalysisResult } });
  await w.deps.store.enqueue(LEAD, OWNER, { reportDone: true });
  await runLeadDbDelivery(LEAD, w.deps);
  assert.equal(w.row().status, 'sent');
  assert.equal(w.row().last_error, 'no_report_figures');
  assert.equal((await sweepLeadDbDeliveries(10, {}, w.deps)).enqueued, 0);
});

test('a non-retryable error stops at once; it is not tried again', async () => {
  const w = world();
  w.setResponder(() => fail('no_product', false));
  await w.deps.store.enqueue(LEAD, OWNER, { reportDone: false });
  await runLeadDbDelivery(LEAD, w.deps);
  assert.equal(w.row().status, 'failed');
  assert.equal(w.row().attempts, 1);
  assert.equal(w.row().last_error, 'no_product');
  assert.deepEqual(w.linkCalls, [{ ok: false, code: 'no_product' }]);
  w.clock.t += 24 * 3600_000;
  assert.equal(await runLeadDbDelivery(LEAD, w.deps), null, 'a failed row is not claimed');
  assert.equal(w.posts.length, 1);
});

test('after 6 retryable attempts the delivery is failed', async () => {
  const w = world();
  w.setResponder(() => fail('network', true));
  await w.deps.store.enqueue(LEAD, OWNER, { reportDone: false });
  for (let i = 1; i <= 6; i++) {
    assert.ok(await runLeadDbDelivery(LEAD, w.deps));
    assert.equal(w.row().attempts, i);
    if (i < 6) assert.equal(w.row().status, 'pending', `attempt ${i}`);
    w.clock.t += 61 * 60_000;
  }
  assert.equal(w.row().status, 'failed');
  assert.equal(w.row().last_error, 'network');
  assert.equal(w.posts.length, 6);
});

test('no link, or a revoked one: nothing is sent and the row fails as not_linked', async () => {
  for (const link of [null, { ownerId: OWNER, status: 'revoked' } as LinkState, { ownerId: OWNER, status: 'code_sent' } as LinkState]) {
    const w = world({ link });
    await w.deps.store.enqueue(LEAD, OWNER, { reportDone: false });
    await runLeadDbDelivery(LEAD, w.deps);
    assert.equal(w.posts.length, 0);
    assert.equal(w.row().status, 'failed');
    assert.equal(w.row().last_error, 'not_linked');
  }
});

test('a row is claimed by one runner: a second concurrent run gets null', async () => {
  const w = world();
  await w.deps.store.enqueue(LEAD, OWNER, { reportDone: false });
  const [a, b] = await Promise.all([runLeadDbDelivery(LEAD, w.deps), runLeadDbDelivery(LEAD, w.deps)]);
  assert.equal([a, b].filter(Boolean).length, 1);
  assert.equal(w.posts.length, 1);
});

test('enqueue never throws, and only queues for a linked owner', async () => {
  const w = world();
  w.deps.store.context = async () => { throw new Error('db down'); };
  assert.equal(await enqueueLeadDbPush(LEAD, w.deps), 'skipped');

  const unlinked = world({ link: null });
  assert.equal(await enqueueLeadDbPush(LEAD, unlinked.deps), 'skipped');
  const notWebsite = world({ ctx: { report: null } });
  assert.equal(await enqueueLeadDbPush(LEAD, notWebsite.deps), 'skipped');
  const ok = world();
  assert.equal(await enqueueLeadDbPush(LEAD, ok.deps), 'queued');
  assert.equal(ok.rows.size, 1);
});

test('drain: a dry run lists what is due and sends nothing; a real run sends it', async () => {
  const w = world();
  await w.deps.store.enqueue(LEAD, OWNER, { reportDone: false });
  const dry = await drainLeadDbDeliveries(10, { dry: true }, w.deps);
  assert.deepEqual(dry.due, [{ lead_id: LEAD, attempts: 0 }]);
  assert.equal(w.posts.length, 0);
  assert.equal(w.row().status, 'pending');
  const real = await drainLeadDbDeliveries(10, {}, w.deps);
  assert.deepEqual([real.attempted, real.sent, real.failed], [1, 1, 0]);
  const sweepDry = await sweepLeadDbDeliveries(10, { dry: true }, world().deps);
  assert.deepEqual(sweepDry.would, [{ leadId: LEAD, ownerId: OWNER }]);
  assert.equal(sweepDry.enqueued, 0);
});

test('no address in logs or stored errors, whatever fails', async () => {
  const w = world();
  w.setResponder(() => fail('http_500', true));
  await w.deps.store.enqueue(LEAD, OWNER, { reportDone: false });
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
  try {
    await runLeadDbDelivery(LEAD, w.deps);
    w.deps.store.context = async () => { throw new Error(ADDRESS); };
    await enqueueLeadDbPush(LEAD, w.deps);
  } finally { console.error = orig; }
  assert.ok(!logged.join('\n').includes('Acacia'));
  assert.ok(!JSON.stringify([...w.rows.values()]).includes('Acacia'));
});

test('source pin: leads.status and crm_pushed_at are never written, and no secret is in code', () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  for (const f of ['./deliver.ts', './store.ts', './links.ts', './client.ts', './payload.ts']) {
    const src = strip(readFileSync(new URL(f, import.meta.url), 'utf8'));
    assert.doesNotMatch(src, /crm_pushed_at|crm_item_id|status:\s*'pushed'/, f);
    assert.doesNotMatch(src, /from\('leads'\)\s*\.\s*(update|insert|upsert|delete)/, f);
    assert.doesNotMatch(src, /whsec_|SI_LEAD_PUSH_SECRET\s*=\s*['"]/, f);
  }
});
