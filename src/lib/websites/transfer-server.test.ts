import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Batch 37 (Phase 5b): pins on the live wiring. transfer-server.ts is 'server-only' (it cannot be
 * imported under node --test), so these read its source. The engine's behaviour, its dry runs and
 * its log lines are pinned by transfer-run.test.ts against counting fakes; here the file is held to
 * "it only binds".
 */
const src = readFileSync(new URL('./transfer-server.ts', import.meta.url), 'utf8');

const DEPS_START = src.indexOf('export function liveTransferDeps');
const ENTRY_START = src.indexOf('// ── Entry points');
const entry = src.slice(ENTRY_START);
const deps = src.slice(DEPS_START, ENTRY_START);

/** The body of an exported function, from its signature to the next top-level `}` line. */
function body(name: string): string {
  const at = src.indexOf(`export async function ${name}(`);
  assert.ok(at >= 0, `${name} exists`);
  const end = src.indexOf('\n}\n', at);
  return src.slice(at, end + 3);
}

test("'server-only' is the first import, as in the neighbouring live files", () => {
  assert.match(src, /^import 'server-only';/);
});

test('the zips live in the private bucket website-transfers and only that bucket is named', () => {
  assert.match(src, /const BUCKET = 'website-transfers';/);
  const buckets = [...src.matchAll(/\.storage\.from\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(buckets.length >= 4, 'upload, download, remove and signed link');
  for (const b of buckets) assert.equal(b, 'BUCKET');
  assert.doesNotMatch(src, /getPublicUrl/);
});

test('startTransferLive: the owner id is its first argument only, and nothing in the input names an owner', () => {
  const fn = body('startTransferLive');
  assert.match(fn, /startTransferLive\(ownerId: string, input: \{ providerKey\?: unknown; tag\?: unknown; dryRun\?: boolean \}\)/);
  assert.doesNotMatch(fn, /input\.(ownerId|owner_id|userId|user_id|websiteId|website_id|funnelId)/);
  assert.doesNotMatch(fn, /\.\.\.input/);
  // The engine gets the three fields it takes, by name, and the owner from the argument.
  assert.match(fn, /engine\.startTransfer\(liveTransferDeps\(\), ownerId, \{ providerKey: input\.providerKey, tag: input\.tag, dryRun: input\.dryRun \}\)/);
  assert.match(fn, /UUID\.test\(ownerId\)/);
});

test('no entry point reads an owner, website or funnel id from its input; admin actions take a transfer id only', () => {
  assert.doesNotMatch(entry, /opts\.(ownerId|owner_id|userId|websiteId|funnelId)/);
  for (const name of ['retryExportLive', 'markTagChangedLive', 'sendCodeLive', 'markMovedLive', 'cancelLive', 'endOverlapNowLive', 'startNewSetupLive']) {
    assert.match(src, new RegExp(`export const ${name} = \\(id: string`), name);
  }
});

test('every admin action passes the dry-run flag to the engine, whose own dry run writes and sends nothing', () => {
  for (const [live, fn] of [
    ['retryExportLive', 'retryExport'],
    ['markTagChangedLive', 'markTagChanged'],
    ['sendCodeLive', 'sendCode'],
    ['markMovedLive', 'markMoved'],
    ['cancelLive', 'cancel'],
    ['endOverlapNowLive', 'endOverlapNow'],
    ['startNewSetupLive', 'startNewSetup'],
  ] as const) {
    const m = new RegExp(`export const ${live} = [^\\n]*engine\\.${fn}\\(d, id, [^\\n]*dryRun`).exec(src);
    assert.ok(m, `${live} calls engine.${fn} with dryRun`);
  }
  assert.match(src, /adminRun\(id: string, dryRun: boolean \| undefined/);
  assert.match(src, /const dry = Boolean\(dryRun\);/);
});

test('a dry run of a cron step lists ids and the step name, and returns before the engine is called', () => {
  const at = src.indexOf('async function sweep(');
  const fn = src.slice(at, src.indexOf('\n}\n', at));
  const dry = fn.indexOf('if (dryRun) return { step, dryRun: true, ids, results: [] };');
  const first = fn.indexOf('runOne(');
  const deps = fn.indexOf('liveTransferDeps()');
  assert.ok(dry > 0 && first > dry && deps > dry, 'the dry-run return comes before deps are built and before runOne');
  for (const step of ['export', 'email', 'domain', 'poll', 'stuck', 'overlap']) assert.match(src, new RegExp(`run${step[0].toUpperCase()}${step.slice(1)}Step = `), step);
});

test('below the deps there is no write of any kind: the entry points reach the database, mail and registrar only through the engine', () => {
  for (const bad of [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/, /sendEmail\(/, /recordActivity\(/, /\.storage\b/, /getRegistrar\(/, /fetch\(/]) {
    assert.doesNotMatch(entry, bad, String(bad));
  }
});

test('claims are conditional updates: set the column where it is still null and return the row', () => {
  const claim = deps.slice(deps.indexOf('claim: async'), deps.indexOf('unclaim: async'));
  assert.match(claim, /\.is\(col, null\)/);
  assert.match(claim, /\.select\('id'\)/);
  assert.match(claim, /=== 1/);
  const attempt = deps.slice(deps.indexOf('claimExportAttempt: async'), deps.indexOf('// The site and its domain'));
  assert.match(attempt, /\.eq\('export_attempts', expected\)/);
  assert.match(attempt, /\.eq\('export_state', 'pending'\)/);
});

test('the domain is released without a registrar call, renewal uses Batch 33 helpers, the pause is the usual status move', () => {
  assert.match(src, /liveDomainEngine\(\)\.release\(domainId, opts\)/);
  assert.match(src, /liveDomainEngine\(\)\.blockRenewal\(websiteId\)/);
  assert.match(src, /liveDomainEngine\(\)\.allowRenewal\(websiteId\)/);
  assert.match(src, /setStatus\(site\.ownerId, 'paused'\)/);
  assert.match(src, /registrar: \(\) => getRegistrar\(\)/);
});

test('mail goes direct through sendEmail (no daily-cap slot) with the attachment passed through', () => {
  assert.match(src, /import \{ sendEmail \} from '\.\.\/email\/send';/);
  assert.doesNotMatch(src, /notify\/sends|claimSlot|finishSend|markSending/);
  assert.match(src, /attachments: opts\.attachments\.map/);
});

test('no log line carries an address, a code, a body or a link', () => {
  const calls = [...src.matchAll(/console\.(log|info|debug|warn|error)\(([^;]*)\);/g)];
  assert.ok(calls.length >= 5);
  for (const m of calls) {
    const args = m[2];
    // The engine's own line, passed through (it logs ids and codes only: pinned in transfer-run.test.ts).
    if (m[1] === 'log') {
      assert.equal(args.trim(), 'line', m[0]);
      continue;
    }
    assert.match(args, /\[website-transfer\]/, m[0]);
    const identifiers = args.replace(/'[^']*'/g, '');
    assert.doesNotMatch(identifiers, /\b(email|address|domainName|ipsTag|secret|transferCode|typed|copy|url|body|snapshot|to|code)\b/i, m[0]);
    for (const part of identifiers.split(',')) {
      const t = part.trim();
      if (t) assert.match(t, /^(dbCode\(\w+\)|\(err as Error\)\?\.name \?\?)$/, m[0]);
    }
  }
});

test('no new environment name: only EMAIL_FROM is read here (the rest is read by the modules this binds)', () => {
  const names = [...src.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(names)], ['EMAIL_FROM']);
  assert.match(src, /fetchBase: siteUrl\(\), publicBase: siteUrl\(\)/);
});

test('it never writes leads, leads.status or crm_pushed_at, and never touches the access columns', () => {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /from\('leads'\)|crm_pushed_at|ACCESS_COLUMNS|lib\/access/);
  assert.doesNotMatch(code, /report-server|funnels\/|leaddb|tracking/);
});

test('the site returns to setup only from live, paused or preview, and keeps its first-time stamps', () => {
  const reset = deps.slice(deps.indexOf('resetSite: async'), deps.indexOf('registrar: () =>'));
  assert.match(reset, /status: 'setup', paused_at: null/);
  assert.match(reset, /\.in\('status', \['live', 'paused', 'preview'\]\)/);
  assert.doesNotMatch(reset, /approved_at|live_at/);
});
