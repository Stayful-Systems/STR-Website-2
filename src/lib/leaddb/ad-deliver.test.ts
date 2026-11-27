import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  drainAdLeadDeliveries,
  enqueueAdLeadPush,
  runAdDelivery,
  type AdDeliverDeps,
  type AdDeliveryRow,
  type AdFinishPatch,
  type AdLeadContext,
  type AdStore,
  type FrozenAdBilling,
} from './ad-deliver.ts';
import type { AdLeadBody } from './ad-payload.ts';
import type { AdLinkFacts } from './ad-payload.ts';
import type { LeadDbResult } from './client.ts';
import type { AnalysisResult } from '../types.ts';
import type { LandlordLeadRow } from '../leads/dedupe.ts';

/**
 * Batch 55 step 2 (contract section 10): the ad lead queue, behaviourally with a fake store and a fake post, and the
 * hooks and the cron as source pins.
 */
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

const OWNER = '00000000-0000-4000-8000-000000000001';
const LEAD = '0b7c2e9a-5d14-4f6b-9a3e-2c1d0e9f8a7b';
const EARLIER = '0b7c2e9a-5d14-4f6b-9a3e-2c1d0e9f8a70';
const CUSTOMER = '9d6f3a52-0c1e-4b87-9d0a-3f2b1c4d5e6f';
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
const RESULT = { shortLet: { annualRevenue: 28400, occupancyRate: 0.69, averageDailyRate: 112 }, property: { bedrooms: 3 } } as unknown as AnalysisResult;

type Reply = { status: number; code?: string; json?: Record<string, unknown> };
const reply = (r: Reply): LeadDbResult<{ ok: true; code?: string }> =>
  r.status === 200
    ? { ok: true, code: 'ok', retryable: false, status: 200, data: { ok: true, ...(r.json ?? {}) } as { ok: true; code?: string } }
    : { ok: false, code: r.code ?? `http_${r.status}`, retryable: false, status: r.status };

function world(o: {
  ctx?: Partial<AdLeadContext>;
  row?: Partial<AdDeliveryRow>;
  replies?: Reply[];
  link?: AdLinkFacts | null;
  earlier?: LandlordLeadRow[];
  account?: boolean;
  pdf?: Uint8Array | null;
} = {}) {
  const posts: AdLeadBody[] = [];
  const finished: AdFinishPatch[] = [];
  const frozen: FrozenAdBilling[] = [];
  const enqueued: { id: string; reportFinal: boolean }[] = [];
  const replies = [...(o.replies ?? [])];
  const ctx: AdLeadContext = {
    leadId: LEAD, ownerId: OWNER, createdAt: '2026-12-02T14:00:00.000Z', name: 'Ann', email: 'ann@example.test', phone: '07700900123',
    address: '1 Test Road', postcode: 'LS1 1AA', bedrooms: 3, result: null, calculator: true,
    report: { state: 'awaiting_address', qualityOk: null, selfSubmit: false, completedAt: null }, ...o.ctx,
  };
  const row: AdDeliveryRow = {
    lead_id: LEAD, owner_id: OWNER, ld_customer_id: CUSTOMER, attempts: 0, phase_sent: null, billable: null, billable_reason: null, low_data: null, repeat_of_lead_id: null, ...o.row,
  };
  let frozenOnRow: FrozenAdBilling | null = null;
  const store: AdStore = {
    async claim() { return { ...row }; },
    async context() { return ctx; },
    async account() { return o.account === false ? null : { ldCustomerId: CUSTOMER }; },
    async adLink() { return o.link ?? null; },
    async adLeadRows() { return o.earlier ?? []; },
    async freezeBilling(_id, b) { frozen.push(b); frozenOnRow ??= b; return frozenOnRow; },
    async finish(_id, patch) { finished.push(patch); },
    async due() { return [{ ...row }]; },
    async enqueue(id, _o, _c, opts) { enqueued.push({ id, reportFinal: opts.reportFinal }); return 'inserted'; },
    async sweep() { return []; },
    async pendingPackNotices() { return []; },
    async packNoticeResult() {},
  };
  const deps: AdDeliverDeps = {
    store,
    post: async (b) => { posts.push(JSON.parse(JSON.stringify(b))); return reply(replies.shift() ?? { status: 200, json: { code: b.phase === 'lead' ? 'created' : 'report_attached' } }); },
    postPackNotice: async () => reply({ status: 200, json: { code: 'recorded' } }),
    renderPdf: async () => (o.pdf === undefined ? PDF : o.pdf),
    now: () => new Date('2026-12-02T14:10:00.000Z'),
  };
  return { deps, posts, finished, frozen, enqueued };
}

test('the lead phase: exactly the contract fields, the ad tag read at send time, no report and no billing', async () => {
  const w = world({ link: { match: 'code', metaAdIdSeen: '120211234567890123', packAdCode: 'SI-a1b2c3-5B-1' } });
  assert.deepEqual(await runAdDelivery(LEAD, w.deps), { ok: true, code: 'created' });
  assert.equal(w.posts.length, 1, 'the report is not final, so only the lead goes');
  assert.deepEqual(w.posts[0], {
    ld_customer_id: CUSTOMER,
    si_lead_id: LEAD,
    phase: 'lead',
    is_test: false,
    pack_code: 'SI-a1b2c3-5B-1',
    ad_id: '120211234567890123',
    ad_match: 'code',
    repeat_of_si_lead_id: null,
    lead: { name: 'Ann', email: 'ann@example.test', phone: '07700900123', address: '1 Test Road', postcode: 'LS1 1AA', bedrooms: '3', message: 'Enquired through your Facebook ad calculator.' },
  });
  assert.equal(w.finished.at(-1)?.status, 'sent');
  assert.equal(w.finished.at(-1)?.phase_sent, 'lead');
  assert.deepEqual(w.frozen, [], 'billing is not decided before a report phase');
});

test('the report phase: figures, PDF, low_data, frozen billing and report_attached_at; lead then report in one run', async () => {
  const w = world({ ctx: { result: RESULT, report: { state: 'done', qualityOk: true, selfSubmit: false, completedAt: '2026-12-02T14:03:11.000Z' } } });
  assert.deepEqual(await runAdDelivery(LEAD, w.deps), { ok: true, code: 'report_attached' });
  assert.deepEqual(w.posts.map((p) => p.phase), ['lead', 'report']);
  const r = w.posts[1];
  assert.deepEqual(Object.keys(r).sort(), ['billable', 'billable_reason', 'is_test', 'ld_customer_id', 'phase', 'repeat_of_si_lead_id', 'report', 'report_attached_at', 'si_lead_id']);
  assert.equal(r.billable, true);
  assert.equal(r.billable_reason, 'report_ran');
  assert.equal(r.report_attached_at, '2026-12-02T14:03:11.000Z');
  assert.equal(r.report?.occupancy_pct, 69, 'a percent, never a fraction');
  assert.equal(r.report?.low_data, false);
  assert.equal(r.report?.gross_annual_income, 28400);
  assert.equal(r.report?.pdf_base64, Buffer.from(PDF).toString('base64'));
  assert.deepEqual(w.frozen, [{ billable: true, billable_reason: 'report_ran', low_data: false, repeat_of_lead_id: null }]);
  assert.equal(w.finished.at(-1)?.phase_sent, 'report');
});

test('a low-data report is billable as low_data, and carries low_data true', async () => {
  const w = world({ row: { phase_sent: 'lead' }, ctx: { result: RESULT, report: { state: 'done', qualityOk: false, selfSubmit: false, completedAt: null } } });
  await runAdDelivery(LEAD, w.deps);
  assert.equal(w.posts.length, 1);
  assert.equal(w.posts[0].billable, true);
  assert.equal(w.posts[0].billable_reason, 'low_data');
  assert.equal(w.posts[0].report?.low_data, true);
  assert.equal(w.posts[0].report_attached_at, '2026-12-02T14:10:00.000Z', 'no completed time: now');
});

test('a failed report sends report_failed: never billable, no report block', async () => {
  const w = world({ row: { phase_sent: 'lead' }, ctx: { report: { state: 'failed', qualityOk: null, selfSubmit: false, completedAt: '2026-12-02T14:05:00.000Z' } } });
  await runAdDelivery(LEAD, w.deps);
  assert.equal(w.posts[0].phase, 'report_failed');
  assert.equal(w.posts[0].billable, false);
  assert.equal(w.posts[0].billable_reason, 'no_figures');
  assert.equal('report' in w.posts[0], false);
});

test('a test lead (the owner on their own calculator) is sent with is_test on every phase and never billable', async () => {
  const w = world({ ctx: { result: RESULT, report: { state: 'done', qualityOk: true, selfSubmit: true, completedAt: null } } });
  await runAdDelivery(LEAD, w.deps);
  assert.deepEqual(w.posts.map((p) => p.is_test), [true, true]);
  assert.equal(w.posts[1].billable, false);
  assert.equal(w.posts[1].billable_reason, 'test');
});

test('a repeat landlord inside 30 days is billable as repeat, and the earlier si_lead_id goes on the report phase', async () => {
  const earlier = [{ id: EARLIER, email: 'ANN@example.test', phone: null, postcode: 'ls11aa', created_at: '2026-11-20T10:00:00.000Z' }];
  const w = world({ earlier, row: { phase_sent: 'lead' }, ctx: { result: RESULT, report: { state: 'done', qualityOk: false, selfSubmit: false, completedAt: null } } });
  await runAdDelivery(LEAD, w.deps);
  assert.equal(w.posts[0].billable_reason, 'repeat');
  assert.equal(w.posts[0].billable, true);
  assert.equal(w.posts[0].repeat_of_si_lead_id, EARLIER);
  assert.equal(w.posts[0].report?.low_data, true, 'low data is still reported');
  // Outside 30 days: not a repeat. A test repeat stays a test.
  const old = world({ earlier: [{ ...earlier[0], created_at: '2026-10-01T10:00:00.000Z' }], row: { phase_sent: 'lead' }, ctx: { result: RESULT, report: { state: 'done', qualityOk: true, selfSubmit: false, completedAt: null } } });
  await runAdDelivery(LEAD, old.deps);
  assert.equal(old.posts[0].billable_reason, 'report_ran');
  const test2 = world({ earlier, row: { phase_sent: 'lead' }, ctx: { result: RESULT, report: { state: 'done', qualityOk: true, selfSubmit: true, completedAt: null } } });
  await runAdDelivery(LEAD, test2.deps);
  assert.equal(test2.posts[0].billable_reason, 'test');
});

test('billing frozen on the row is sent as it is: never recomputed', async () => {
  const w = world({
    row: { phase_sent: 'lead', billable: false, billable_reason: 'test', low_data: false, repeat_of_lead_id: null },
    ctx: { result: RESULT, report: { state: 'done', qualityOk: true, selfSubmit: true, completedAt: null } },
  });
  await runAdDelivery(LEAD, w.deps);
  assert.deepEqual(w.frozen, []);
  assert.equal(w.posts[0].billable_reason, 'test');
});

test('409 no_lead: the lead goes first, then the report again, in the same run', async () => {
  const w = world({
    row: { phase_sent: 'lead' },
    replies: [{ status: 409, code: 'no_lead' }, { status: 200, json: { code: 'created' } }, { status: 200, json: { code: 'report_attached' } }],
    ctx: { result: RESULT, report: { state: 'done', qualityOk: true, selfSubmit: false, completedAt: null } },
  });
  assert.deepEqual(await runAdDelivery(LEAD, w.deps), { ok: true, code: 'report_attached' });
  assert.deepEqual(w.posts.map((p) => p.phase), ['report', 'lead', 'report']);
  assert.equal(w.posts[0].billable_reason, w.posts[2].billable_reason, 'the same frozen billing both times');
});

test('responses: final refusals fail at once, an unset secret and 5xx retry, and phase_sent is kept right', async () => {
  const cases: [Reply, 'failed' | 'pending'][] = [
    [{ status: 403, code: 'stopped' }, 'failed'],
    [{ status: 403, code: 'unpaid_hold' }, 'failed'],
    [{ status: 404, code: 'unknown_customer' }, 'failed'],
    [{ status: 422, code: 'empty_lead' }, 'failed'],
    [{ status: 429, code: 'daily_cap' }, 'failed'],
    [{ status: 400, code: 'bad_request' }, 'failed'],
    [{ status: 404, code: 'not_available' }, 'pending'],
    [{ status: 401, code: 'bad_signature' }, 'pending'],
    [{ status: 500, code: 'server_error' }, 'pending'],
    [{ status: 0, code: 'network' }, 'pending'],
    [{ status: 0, code: 'not_configured' }, 'pending'],
  ];
  for (const [r, status] of cases) {
    const w = world({ replies: [r] });
    const out = await runAdDelivery(LEAD, w.deps);
    assert.equal(out?.ok, false);
    assert.equal(w.finished.at(-1)?.status, status, `${r.status} ${r.code}`);
    assert.equal(w.finished.at(-1)?.phase_sent, null);
    assert.equal(w.finished.at(-1)?.last_error, r.code);
  }
  // A report phase that fails keeps phase_sent at 'lead', so the lead is not sent again.
  const w = world({ row: { phase_sent: 'lead' }, replies: [{ status: 500, code: 'server_error' }], ctx: { result: RESULT, report: { state: 'done', qualityOk: true, selfSubmit: false, completedAt: null } } });
  await runAdDelivery(LEAD, w.deps);
  assert.equal(w.finished.at(-1)?.phase_sent, 'lead');
  assert.equal(w.finished.at(-1)?.status, 'pending');
});

test('a PDF that cannot be made retries the report later; the lead is not lost', async () => {
  const w = world({ pdf: null, ctx: { result: RESULT, report: { state: 'done', qualityOk: true, selfSubmit: false, completedAt: null } } });
  const out = await runAdDelivery(LEAD, w.deps);
  assert.deepEqual(out, { ok: false, code: 'pdf_not_ready' });
  assert.deepEqual(w.posts.map((p) => p.phase), ['lead']);
  assert.equal(w.finished.at(-1)?.phase_sent, 'lead');
  assert.equal(w.finished.at(-1)?.status, 'pending');
});

test('not a calculator lead, or someone else’s row: failed for good, nothing posted', async () => {
  const site = world({ ctx: { calculator: false } });
  assert.deepEqual(await runAdDelivery(LEAD, site.deps), { ok: false, code: 'not_calculator' });
  assert.equal(site.posts.length, 0);
  assert.equal(site.finished[0].status, 'failed');
  const other = world({ ctx: { ownerId: 'someone-else' } });
  assert.deepEqual(await runAdDelivery(LEAD, other.deps), { ok: false, code: 'owner_mismatch' });
});

test('enqueue: only a calculator lead of an owner with an ad account; reportFinal when done or failed; never throws', async () => {
  assert.equal(await enqueueAdLeadPush(LEAD, world({ ctx: { calculator: false } }).deps), 'skipped');
  assert.equal(await enqueueAdLeadPush(LEAD, world({ account: false }).deps), 'skipped');
  const w = world();
  assert.equal(await enqueueAdLeadPush(LEAD, w.deps), 'queued');
  assert.deepEqual(w.enqueued, [{ id: LEAD, reportFinal: false }]);
  for (const state of ['done', 'failed']) {
    const f = world({ ctx: { report: { state, qualityOk: null, selfSubmit: false, completedAt: null } } });
    await enqueueAdLeadPush(LEAD, f.deps);
    assert.deepEqual(f.enqueued, [{ id: LEAD, reportFinal: true }], state);
  }
  const boom = new Proxy({}, { get() { throw new Error('everything is on fire'); } }) as unknown as AdDeliverDeps;
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
  try {
    assert.equal(await enqueueAdLeadPush(LEAD, boom), 'skipped');
  } finally {
    console.error = orig;
  }
  assert.ok(!logged.join('\n').includes('on fire'));
});

test('the drain: dry lists and sends nothing; pack notices are recorded, final on unknown_customer, retried otherwise', async () => {
  const w = world();
  const results: [string, 'done' | 'final'][] = [];
  let notices = [{ ownerId: OWNER, ldCustomerId: CUSTOMER }];
  w.deps.store.pendingPackNotices = async () => notices;
  w.deps.store.packNoticeResult = async (o, r) => { results.push([o, r]); };
  const dry = await drainAdLeadDeliveries(10, { dry: true }, w.deps);
  assert.equal(w.posts.length, 0);
  assert.deepEqual(dry.wouldNotify, [OWNER]);
  assert.equal(dry.due?.length, 1);
  assert.deepEqual(results, []);

  const live = await drainAdLeadDeliveries(10, {}, w.deps);
  assert.equal(live.sent, 1);
  assert.deepEqual(live.packNotices, { sent: 1, final: 0, retry: 0 });
  assert.deepEqual(results, [[OWNER, 'done']]);

  const replies: Reply[] = [{ status: 404, code: 'unknown_customer' }, { status: 404, code: 'not_available' }, { status: 500, code: 'server_error' }, { status: 200, json: { code: 'already_recorded' } }];
  const seen: string[] = [];
  for (const r of replies) {
    notices = [{ ownerId: OWNER, ldCustomerId: CUSTOMER }];
    results.length = 0;
    w.deps.postPackNotice = async () => reply(r);
    await drainAdLeadDeliveries(10, {}, w.deps);
    seen.push(results[0]?.[1] ?? 'retry');
  }
  assert.deepEqual(seen, ['final', 'retry', 'retry', 'done']);
});

test('the hooks: after the pack-ad link on the form route, after the Batch 32 hook in the report run, and when giveUp fails the report', () => {
  const route = code(read('../../app/api/s/[slug]/lead/route.ts'));
  const HOOK = /void enqueueAdLeadPush\(leadId\)\.catch\(\(\) => \{\}\);/;
  assert.match(route, HOOK);
  assert.ok(route.search(HOOK) > route.indexOf('void linkLeadToPackAd(leadId)'));
  assert.doesNotMatch(route, /await enqueueAdLeadPush/);
  const runner = code(read('../websites/report-server.ts'));
  assert.equal((runner.match(/void enqueueAdLeadPush\(leadId\)\.catch\(\(\) => \{\}\);/g) ?? []).length, 2);
  assert.ok(runner.indexOf('void enqueueAdLeadPush(') > runner.indexOf('void enqueueLeadDbPush('), 'after the Batch 32 hook');
  assert.ok(runner.indexOf('void enqueueAdLeadPush(') > runner.indexOf('if (!done) return'));
  const give = runner.slice(runner.indexOf('async function giveUp'));
  assert.ok(give.indexOf('void enqueueAdLeadPush(') > give.indexOf('if (won) {'), 'only when this call failed the report');
  assert.doesNotMatch(runner, /await enqueueAdLeadPush/);
});

test('the cron runs the ad drain after the Batch 32 drain, with ?dry=1 passed through', () => {
  const src = code(read('../../app/api/internal/leaddb-deliveries/route.ts'));
  assert.ok(src.indexOf('drainLeadDbDeliveries(') < src.indexOf('drainAdLeadDeliveries('));
  assert.match(src, /drainAdLeadDeliveries\(MAX_PER_RUN, \{ dry, budgetMs/);
});

test('the ad queue never writes leads, status or crm_pushed_at, and logs ids and codes only', () => {
  for (const f of ['./ad-deliver.ts', './ad-store.ts', './ad-payload.ts']) {
    const src = code(read(f));
    assert.doesNotMatch(src, /crm_pushed_at/, f);
    assert.doesNotMatch(src, /from\('leads'\)\s*\.update\(/, f);
    for (const m of src.matchAll(/console\.(log|error|warn|info)\(([^\n]*)\);/g)) {
      const args = m[2].replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '');
      assert.doesNotMatch(args, /\b(ctx|body|lead|email|phone|address|postcode|name|result)\b/, `${f}: ${m[0]}`);
      assert.doesNotMatch(m[2], /\.message\b/, `${f}: ${m[0]}`);
    }
  }
});
