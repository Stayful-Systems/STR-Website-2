import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./edit-server.ts', import.meta.url), 'utf8');
const copySrc = readFileSync(new URL('./copy-server.ts', import.meta.url), 'utf8');
const run = readFileSync(new URL('./edit-run.ts', import.meta.url), 'utf8');

test('the only way in is the signed-in owner id: no website, funnel, user or version id is taken from a caller', () => {
  assert.match(src, /export async function editRunFor\(ownerId: string\)/);
  assert.equal([...src.matchAll(/export (async )?function/g)].length, 1, 'editRunFor is the only export');
  // Every write is keyed by the site id read from the owner's own row.
  assert.match(src, /const websiteId = row\.id;/);
  assert.doesNotMatch(src, /\.eq\('user_id'/);
});

test('no log line carries settings, copy, an address or a body', () => {
  for (const m of src.matchAll(/console\.(log|info|debug|warn|error)\(([^;]*)\)/g)) {
    assert.match(m[2], /website-edit\]/, m[0]);
    assert.doesNotMatch(m[2], /settings|pages|copy|email|phone|body|url/i, m[0]);
  }
});

test('edits use the copy writer as kind "edit" (no setup regeneration is taken) and the versions RPCs', () => {
  assert.match(src, /kind: 'edit'/);
  assert.match(src, /rpc\('website_version_publish'/);
  assert.match(src, /rpc\('website_version_snapshot'/);
  assert.match(copySrc, /kind: 'first' \| 'regenerate' \| 'edit'/);
  // The regeneration is only taken for 'regenerate'.
  assert.match(copySrc, /if \(o\.kind === 'regenerate'\)/);
});

test('the run imports nothing server-only and never names the conversion or tracking modules', () => {
  const imports = (text: string) => [...text.matchAll(/^import [^;]*from '([^']+)'/gm)].map((m) => m[1]);
  for (const spec of imports(run)) assert.doesNotMatch(spec, /server-only|tracking|conversions|report-server|charge-server|supabase|storage|activity\/log/, `edit-run imports ${spec}`);
  for (const spec of imports(src)) assert.doesNotMatch(spec, /tracking|conversions|report-server|charge-server/, `edit-server imports ${spec}`);
});
