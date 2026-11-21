import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Batch 37 phase 7: source pins for the website-transfers cron
 * (route.ts). The route needs a database and a registrar, so what is held here
 * is the shape of the code: who may call it, that the dry run reaches nothing
 * but the sweeps' read-only branch, the order of the six steps, the budget, and
 * what it never imports. The sweeps' own dry-run behaviour (no write, no email,
 * no registrar call) is pinned in src/lib/websites/transfer-server.test.ts and
 * transfer-run.test.ts.
 */
const routeSrc = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');
const vercel = JSON.parse(readFileSync(new URL('../../../../../vercel.json', import.meta.url), 'utf8')) as { crons: Array<{ path: string; schedule: string }> };

/** Source with comments removed, so a rule about code is not satisfied (or broken) by prose. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
const route = code(routeSrc);

test('the route is authorised like website-grace, before any step runs', () => {
  assert.match(route, /import \{ authoriseInternal, internalSecretsConfigured \} from '@\/lib\/internal-auth'/);
  assert.match(route, /if \(!internalSecretsConfigured\(\)\) return Response\.json\(\{ error: 'Not found' \}, \{ status: 404 \}\)/);
  assert.match(route, /if \(!authoriseInternal\(request\)\) return Response\.json\(\{ error: 'Unauthorized' \}, \{ status: 401 \}\)/);
  assert.ok(route.indexOf('internalSecretsConfigured()') < route.indexOf('authoriseInternal(request)'));
  assert.ok(route.indexOf('authoriseInternal(request)') < route.indexOf('await run('));
  assert.match(routeSrc, /export const maxDuration = 60;/);
});

test('the six steps run in the plan order', () => {
  const order = [...route.matchAll(/\['(\w+)', run\w+Step\]/g)].map((m) => m[1]);
  assert.deepEqual(order, ['export', 'email', 'domain', 'poll', 'stuck', 'overlap']);
  assert.match(route, /\['export', runExportStep\]/);
  assert.match(route, /\['email', runEmailStep\]/);
  assert.match(route, /\['domain', runDomainStep\]/);
  assert.match(route, /\['poll', runPollStep\]/);
  assert.match(route, /\['stuck', runStuckStep\]/);
  assert.match(route, /\['overlap', runOverlapStep\]/);
});

test('the dry run passes dryRun to every step and does nothing of its own', () => {
  assert.match(route, /get\('dry'\) === '1'/);
  // One call site for every step, handed the dry flag and the deadline.
  assert.equal((route.match(/await run\(/g) ?? []).length, 1);
  assert.match(route, /await run\(\{ dryRun: dry, until \}\)/);
  // The route itself writes nothing, sends nothing and talks to no registrar.
  assert.doesNotMatch(route, /\.(update|insert|upsert|delete|rpc|from)\(/);
  assert.doesNotMatch(route, /sendEmail|sendOwner|sendAdmin|registrar|liveTransferDeps|createAdminClient|fetch\(/i);
  // Only the six sweeps are imported from the engine's live wiring (no admin action, no start).
  const imported = /import \{([^}]*)\} from '@\/lib\/websites\/transfer-server'/.exec(route)?.[1] ?? '';
  assert.deepEqual(
    imported.split(',').map((s) => s.trim().replace(/^type /, '')).filter(Boolean).sort(),
    ['StepName', 'SweepOpts', 'SweepResult', 'runDomainStep', 'runEmailStep', 'runExportStep', 'runOverlapStep', 'runPollStep', 'runStuckStep'].sort(),
  );
});

test('a 40-second budget: no step is started after the deadline, and the sweeps get it as `until`', () => {
  assert.match(route, /const BUDGET_MS = 40_000;/);
  assert.match(route, /const until = started \+ BUDGET_MS;/);
  assert.match(route, /if \(Date\.now\(\) > until\) \{[\s\S]*skipped: 'out_of_time'[\s\S]*continue;/);
  assert.ok(40_000 < 60_000);
});

test('logs and the response carry ids and codes only', () => {
  const logs = route.split('\n').filter((l) => /console\.(error|log|warn)\(/.test(l));
  assert.ok(logs.length >= 1);
  for (const l of logs) {
    assert.match(l, /err instanceof Error \? err\.name : 'error'/);
    assert.doesNotMatch(l, /\.message|\bbody\b|email|address|code\b/i);
  }
  // The body is the steps' own SweepResult (ids, step names, codes) and the run time.
  assert.match(route, /Response\.json\(\{ dry, steps, ms: Date\.now\(\) - started \}\)/);
});

test('vercel.json declares the route once, at 6-59/10 * * * *, and it is the last cron', () => {
  const entries = vercel.crons.filter((c) => c.path === '/api/internal/website-transfers');
  assert.deepEqual(entries, [{ path: '/api/internal/website-transfers', schedule: '6-59/10 * * * *' }]);
  assert.equal(vercel.crons[vercel.crons.length - 1].path, '/api/internal/website-transfers');
  // Other crons are unchanged and none shares this route's schedule.
  assert.equal(vercel.crons.filter((c) => c.schedule === '6-59/10 * * * *').length, 1);
});
