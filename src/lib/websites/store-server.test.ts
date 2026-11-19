import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** Batch 31 phase 5: source pins for the websites store. */
const src = readFileSync(new URL('./store-server.ts', import.meta.url), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('a website funnel is created kind=website and inactive, and nothing here ever activates a funnel', () => {
  assert.match(code, /kind: 'website', active: false/);
  assert.doesNotMatch(code, /active:\s*true/);
  // The only write to funnels is the insert (and the rollback delete of that same row).
  assert.equal((code.match(/from\('funnels'\)/g) ?? []).length, 2);
  assert.doesNotMatch(code, /from\('funnels'\)\s*\.update/);
  assert.match(code, /\.from\('funnels'\)\.delete\(\)\.eq\('id', funnelId\)\.eq\('kind', 'website'\)/);
});

test('only account owners are invited, one site per member, through the management stamp and the plan gate', () => {
  assert.match(code, /await ownerIdOrNull\(\{ id: o\.memberId \}\)/);
  assert.match(code, /websiteAccess\(/);
  assert.match(code, /'invite'/);
  assert.match(code, /already_has_site/);
  assert.match(code, /status: 'invited'/);
});

test('the access gate columns are not touched', () => {
  assert.doesNotMatch(src, /ACCESS_COLUMNS/);
});

test('settings, pages and checks writes never touch status, slug, funnel or owner', () => {
  const upd = src.slice(src.indexOf('async function updateOwn'), src.indexOf('// ── Status'));
  assert.match(upd, /\.eq\('user_id', ownerId\)/);
  for (const key of ['saveSettings', 'savePages', 'saveChecks', 'bumpRegen']) {
    const body = src.slice(src.indexOf(`export async function ${key}(`));
    const head = body.slice(0, body.indexOf('\n}\n'));
    assert.doesNotMatch(head, /status|slug|funnel_id|user_id/, key);
  }
});

test('status moves are conditional on the status read, and follow the transition table', () => {
  const set = src.slice(src.indexOf('export async function setStatus'));
  assert.match(set, /canMoveStatus\(current\.status, to\)/);
  assert.match(set, /\.eq\('status', current\.status\)/);
  assert.match(src, /invited: \['setup'\]/);
  assert.match(src, /live: \['paused'\]/);
  assert.match(src, /preview: \['setup', 'live'\]/);
});

test('the public lookup reads live sites only', () => {
  const live = src.slice(src.indexOf('export async function liveSiteBySlug'), src.indexOf('export async function ownSite('));
  assert.match(live, /\.eq\('status', 'live'\)/);
  assert.match(live, /slugProblem\(slug\) !== null/);
});
