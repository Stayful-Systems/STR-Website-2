import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { enqueueLeadDbPush, type LeadDbDeps } from './deliver.ts';

/**
 * Batch 32 phase 3: the two one-line hooks and the cron route, in the repo's
 * source-pin style (the routes need a database and Next).
 */
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const HOOK = /void enqueueLeadDbPush\(leadId\)\.catch\(\(\) => \{\}\);/;

test('form route: the hook comes after the report row exists and before the operator email, and is never awaited', () => {
  const src = code(read('../../app/api/s/[slug]/lead/route.ts'));
  assert.match(src, HOOK);
  assert.equal((src.match(/enqueueLeadDbPush\(/g) ?? []).length, 1);
  const hook = src.search(HOOK);
  assert.ok(hook > src.indexOf("from('website_reports')\n    .upsert"), 'after the website_reports upsert (an enqueue needs the row)');
  assert.ok(hook < src.indexOf('await notifyOperatorOfWebsiteLead'));
  assert.doesNotMatch(src, /await enqueueLeadDbPush/);
});

test('report run: the hook comes after the report is marked done, and is never awaited', () => {
  const src = code(read('../websites/report-server.ts'));
  assert.match(src, HOOK);
  assert.equal((src.match(/enqueueLeadDbPush\(/g) ?? []).length, 1);
  const hook = src.search(HOOK);
  assert.ok(hook > src.indexOf("state: 'done', quality_ok: quality"), 'after endRun(done)');
  assert.ok(hook > src.indexOf('if (!done) return'), 'only when this run finished the report');
  assert.doesNotMatch(src, /await enqueueLeadDbPush/);
});

test('the form route still answers when enqueue throws: enqueue swallows everything', async () => {
  const boom = new Proxy({}, { get() { throw new Error('everything is on fire'); } }) as unknown as LeadDbDeps;
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
  try {
    assert.equal(await enqueueLeadDbPush('lead-1', boom), 'skipped');
  } finally {
    console.error = orig;
  }
  assert.ok(!logged.join('\n').includes('on fire'));
});

test('the cron route: 404 with no secret, 401 when wrong, dry lists only, runs the sweep then the drain', () => {
  const src = code(read('../../app/api/internal/leaddb-deliveries/route.ts'));
  assert.ok(src.indexOf('internalSecretsConfigured()') < src.indexOf('authoriseInternal(request)'));
  assert.match(src, /internalSecretsConfigured\(\)\) return new Response\('Not found', \{ status: 404 \}\)/);
  assert.match(src, /authoriseInternal\(request\)\) return new Response\('Unauthorised', \{ status: 401 \}\)/);
  assert.match(src, /searchParams\.get\('dry'\) === '1'/);
  assert.ok(src.indexOf('sweepLeadDbDeliveries') < src.indexOf('drainLeadDbDeliveries('));
  assert.match(src, /sweepLeadDbDeliveries\(50, \{ dry \}\)/);
  assert.match(src, /drainLeadDbDeliveries\(MAX_PER_RUN, \{ dry, budgetMs/);
});

test('vercel.json schedules the cron at 3-59/10 * * * *', () => {
  const cfg = JSON.parse(read('../../../vercel.json')) as { crons: { path: string; schedule: string }[] };
  const c = cfg.crons.filter((x) => x.path === '/api/internal/leaddb-deliveries');
  assert.deepEqual(c, [{ path: '/api/internal/leaddb-deliveries', schedule: '3-59/10 * * * *' }]);
});
