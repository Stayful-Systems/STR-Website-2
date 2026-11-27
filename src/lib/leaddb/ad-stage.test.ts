import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStageBody, runStageUpdate, stageIsNewer, type AdStageDeps, type StageLead } from './ad-stage.ts';

/**
 * Batch 55 step 2 (contract section 11): the lead database's stage push on an ad lead. The decision behaviourally,
 * and the route and live wiring as source pins (they need a database and Next).
 */
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

const OWNER = '00000000-0000-4000-8000-000000000001';
const LEAD = '0b7c2e9a-5d14-4f6b-9a3e-2c1d0e9f8a7b';
const body = (over: Record<string, unknown> = {}) => ({
  ld_customer_id: '9d6f3a52-0c1e-4b87-9d0a-3f2b1c4d5e6f',
  si_lead_id: LEAD,
  stage: 'meeting_booked',
  ld_stage: 'web_meeting_booked',
  stageAt: '2026-12-05T09:12:00.000Z',
  ...over,
});

function world(leadOver: Partial<StageLead> | null = {}, opts: { owner?: string | null; writeOk?: boolean; throws?: boolean } = {}) {
  const writes: { stage: string; at: string }[] = [];
  const stamps: string[] = [];
  const deps: AdStageDeps = {
    async ownerOfCustomer() {
      if (opts.throws) throw new Error('db down');
      return opts.owner === undefined ? OWNER : opts.owner;
    },
    async lead() {
      return leadOver === null ? null : { id: LEAD, ownerId: OWNER, calculator: true, ldStageAsOf: null, meetingReachedAt: null, ...leadOver };
    },
    async writeStage(_o, _l, stage, at) {
      writes.push({ stage, at });
      return opts.writeOk ?? true;
    },
    async stampMeeting(_o, _l, at) {
      stamps.push(at);
    },
  };
  return { deps, writes, stamps };
}

test('the body: closed stage list, uuid lead id, ISO stageAt; ld_stage optional', () => {
  assert.ok(parseStageBody(body()));
  assert.ok(parseStageBody(body({ ld_stage: undefined })));
  assert.equal(parseStageBody(body({ stage: 'won' })), null, 'LD words are mapped by LD, never accepted here');
  assert.equal(parseStageBody(body({ si_lead_id: 'not-a-uuid' })), null);
  assert.equal(parseStageBody(body({ stageAt: 'yesterday' })), null);
  assert.equal(parseStageBody(body({ ld_customer_id: '' })), null);
  assert.equal(parseStageBody(body({ ld_stage: 'Has Spaces' })), null);
  assert.equal(parseStageBody([]), null);
  for (const s of ['new', 'contacted', 'meeting_booked', 'signed', 'lost']) assert.ok(parseStageBody(body({ stage: s })), s);
});

test('applied: writes the stage at stageAt and stamps a meeting once', async () => {
  const w = world();
  assert.deepEqual(await runStageUpdate(w.deps, body()), { status: 200, body: { ok: true, code: 'applied' } });
  assert.deepEqual(w.writes, [{ stage: 'meeting_booked', at: '2026-12-05T09:12:00.000Z' }]);
  assert.deepEqual(w.stamps, ['2026-12-05T09:12:00.000Z']);
  // Already stamped: never again. A non-meeting stage never stamps.
  const again = world({ meetingReachedAt: '2026-12-01T00:00:00.000Z' });
  await runStageUpdate(again.deps, body({ stage: 'signed' }));
  assert.deepEqual(again.stamps, []);
  const lost = world();
  await runStageUpdate(lost.deps, body({ stage: 'lost' }));
  assert.deepEqual(lost.stamps, []);
});

test('ordering by stageAt: newer and equal apply, older is stale and writes nothing', async () => {
  assert.equal(stageIsNewer(null, '2026-12-05T09:00:00Z'), true);
  assert.equal(stageIsNewer('2026-12-05T09:00:00Z', '2026-12-05T09:00:00Z'), true);
  assert.equal(stageIsNewer('2026-12-05T09:00:00Z', '2026-12-05T08:59:59Z'), false);
  const older = world({ ldStageAsOf: '2026-12-06T00:00:00.000Z' });
  assert.deepEqual(await runStageUpdate(older.deps, body()), { status: 200, body: { ok: true, code: 'stale' } });
  assert.deepEqual(older.writes, []);
  const equal = world({ ldStageAsOf: '2026-12-05T09:12:00.000Z' });
  assert.equal((await runStageUpdate(equal.deps, body())).body.code, 'applied');
  // A newer push that landed between the read and the write: the SQL filter matched nothing, so stale.
  const raced = world({}, { writeOk: false });
  assert.equal((await runStageUpdate(raced.deps, body())).body.code, 'stale');
  assert.deepEqual(raced.stamps, []);
});

test('refusals: bad body 400, unknown customer 404, a lead that is not this customer’s calculator lead 404, a failure 500', async () => {
  assert.deepEqual(await runStageUpdate(world().deps, body({ stage: 'bogus' })), { status: 400, body: { ok: false, code: 'bad_request' } });
  assert.deepEqual(await runStageUpdate(world({}, { owner: null }).deps, body()), { status: 404, body: { ok: false, code: 'unknown_customer' } });
  assert.deepEqual(await runStageUpdate(world(null).deps, body()), { status: 404, body: { ok: false, code: 'unknown_lead' } });
  const site = world({ calculator: false });
  assert.deepEqual(await runStageUpdate(site.deps, body()), { status: 404, body: { ok: false, code: 'unknown_lead' } });
  assert.deepEqual(site.writes, [], 'a site-mode lead’s stage is never moved by the lead database');
  assert.equal((await runStageUpdate(world({ ownerId: 'someone-else' }).deps, body())).body.code, 'unknown_lead');
  assert.deepEqual(await runStageUpdate(world({}, { throws: true }).deps, body()), { status: 500, body: { ok: false, code: 'server_error' } });
});

test('the stage route: POST only, verifyInbound first, the decision in ad-stage.ts, codes only, no mailer', () => {
  const raw = read('../../app/api/internal/si/ad-route/stage/route.ts');
  const c = code(raw);
  assert.match(raw, /export const dynamic = 'force-dynamic';/);
  assert.doesNotMatch(c, /export async function (GET|PUT|PATCH|DELETE)\b/);
  const handler = c.slice(c.indexOf('export async function POST'));
  assert.match(handler, /^export async function POST\(request: Request\) \{\s*const verified = await verifyInbound\(request\);\s*if \(!verified\.ok\) return verified\.response;/);
  assert.equal((c.match(/request\.(json|text|formData|headers)/g) ?? []).length, 0);
  assert.match(c, /runStageUpdate\(liveAdStageDeps\(\), verified\.json\)/);
  assert.match(c, /Response\.json\(outcome\.body, \{ status: outcome\.status \}\)/);
  assert.doesNotMatch(c, /sendEmail|@\/lib\/email|resend/i);
  assert.doesNotMatch(c, /\.(from|insert|update|upsert|delete|rpc)\(/);
  for (const m of c.matchAll(/console\.(log|error|warn|info)\(([^\n]*)\);/g)) assert.doesNotMatch(m[2], /verified|json|body\b(?!\.code)/, m[0]);
});

test('the live wiring writes only the stage columns and the meeting stamp, never status or crm_pushed_at', () => {
  const c = code(read('./ad-stage-server.ts'));
  assert.doesNotMatch(c, /crm_pushed_at|\bstatus:/);
  assert.match(c, /update\(\{ stage, stage_changed_at: stageAtIso, ld_stage_as_of: stageAtIso \}\)/);
  assert.match(c, /\.or\(`ld_stage_as_of\.is\.null,ld_stage_as_of\.lte\.\$\{stageAtIso\}`\)/);
  assert.match(c, /update\(\{ meeting_reached_at: atIso \}\)[\s\S]*?\.is\('meeting_reached_at', null\)/);
  assert.equal((c.match(/\.update\(/g) ?? []).length, 2);
  for (const m of c.matchAll(/console\.(log|error|warn|info)\(([^\n]*)\);/g)) assert.doesNotMatch(m[2], /\.message\b/, m[0]);
});
