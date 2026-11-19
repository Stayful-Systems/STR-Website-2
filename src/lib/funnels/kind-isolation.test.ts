import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Batch 31 phase 2: customer websites live in `funnels` as kind='website'
 * rows, and none of the form-funnel lookups may ever see or change one.
 * Source pin: each function below must carry `.eq('kind', 'form')` inside its
 * own body, so a website row cannot be listed, loaded by token, edited,
 * rotated or stamped live through the funnel code paths.
 */
const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

const FILTERED = [
  'listFunnels',
  'getFunnel',
  'updateFunnel',
  'rotateFunnelToken',
  'funnelByToken',
  'funnelPageByToken',
  'ownPublicFunnelByToken',
  'ownedFunnelByToken',
  'markFirstLive',
];

/** The text of `export async function <name>` up to the next top-level declaration. */
function body(name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const rest = src.slice(start + 10);
  const next = rest.search(/\n(?:export |function |async function |\/\*\*)/);
  return rest.slice(0, next < 0 ? undefined : next);
}

for (const name of FILTERED) {
  test(`${name} filters kind = 'form'`, () => {
    const b = body(name);
    assert.ok(b.includes("from('funnels')"), `${name} reads funnels`);
    assert.equal((b.match(/\.eq\('kind', 'form'\)/g) ?? []).length, 1, `${name} carries exactly one kind filter`);
  });
}

test('every funnels query in index.ts is accounted for', () => {
  // createFunnel inserts (default kind 'form'); notifyNewLeadOf is only reached
  // after getFunnel/ownership checks and reads a single setting by id + user.
  const unfiltered = ['createFunnel', 'notifyNewLeadOf'];
  const names = [...src.matchAll(/export async function (\w+)\(/g)].map((m) => m[1]);
  for (const n of names) {
    if (FILTERED.includes(n) || unfiltered.includes(n)) continue;
    assert.ok(!body(n).includes("from('funnels')"), `${n} queries funnels but is not in the kind-filter list`);
  }
});

test('Funnel carries kind and the full-row select includes it', () => {
  assert.match(src, /export type FunnelKind = 'form' \| 'website'/);
  assert.match(src, /kind: FunnelKind;/);
  assert.match(src, /const COLUMNS =\s*'id, user_id, public_token, name, kind,/);
  assert.match(src, /kind: r\.kind === 'website' \? 'website' : 'form'/);
});

test('/leads only redirects to funnel setup when the owner has no website either', () => {
  const page = readFileSync(new URL('../../app/leads/page.tsx', import.meta.url), 'utf8');
  const line = page.split('\n').find((l) => l.includes('redirect(SETUP_PATH)')) ?? '';
  assert.match(line, /funnels\.length === 0/);
  assert.match(line, /isManagementAccount\(user\.id\)/);
  assert.match(line, /!\(await ownsWebsite\(scope\.ownerId\)\)/);
  assert.match(page, /from\("websites"\)[\s\S]{0,120}\.eq\("user_id", ownerId\)/);
});
