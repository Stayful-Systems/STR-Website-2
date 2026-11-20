import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chooseProblemText, memberDomainView } from '../../../../lib/domains/member-view.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
/** Source with comments removed, so a rule about code is not satisfied (or broken) by prose. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

const actions = code(read('./domain-actions.ts'));

test('the action finds the site from who is signed in and reads only the chosen name from the form: never a website id, slug or user id', () => {
  assert.match(actions, /const r = await websiteActor\(\);/);
  assert.match(actions, /chooseName\(\{ websiteId: r\.actor\.site\.id, name \}\)/);
  const reads = [...actions.matchAll(/formData\.get\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.deepEqual(reads, ["'name'"]);
  assert.doesNotMatch(actions, /formData\.(getAll|entries|keys|values)|Object\.fromEntries\(formData/);
  assert.doesNotMatch(actions, /websiteId:\s*(formData|String\(|name\b|slug)/);
  assert.doesNotMatch(actions, /slug|siteById|liveSiteBySlug|ownSite\(/);
  assert.match(actions, /^'use server';/m);
});

test('the picker posts the chosen name and nothing else, and never shows a price or a registrar detail', () => {
  const picker = code(read('./DomainPicker.tsx'));
  assert.match(picker, /name="name"/);
  assert.equal([...picker.matchAll(/name="/g)].length, 1, 'one posted field');
  assert.doesNotMatch(picker, /type="hidden"/);
  assert.doesNotMatch(picker, /£|price|pence|registrar|cost/i);
  assert.match(picker, /first year free/);
  assert.match(picker, /Suggested/);
});

test('the section draws plain words from the member view and passes names only to the picker', () => {
  const section = code(read('./DomainSection.tsx'));
  assert.match(section, /memberDomainView\(/);
  assert.match(section, /<DomainPicker names=\{offer\.names\} again=\{view\.again\} \/>/);
  assert.doesNotMatch(section, /prices|costPence|lastError|registrarRef|last_error/);
  assert.match(section, /usually takes under an hour/);
  assert.match(read('./Notice.tsx'), /<DomainSection site=\{site\} \/>/);
});

test('the status card: choose, setting up, live, waiting, or nothing', () => {
  const row = (status: Parameters<typeof memberDomainView>[0]['row'] extends infer R ? (R extends { status: infer S } ? S : never) : never) => ({ status, name: 'harbourmanagement.co.uk' });
  const view = (o: Partial<Parameters<typeof memberDomainView>[0]>) => memberDomainView({ siteStatus: 'live', row: null, releasedBefore: false, buyingOn: true, ...o });

  assert.deepEqual(view({}), { kind: 'choose', again: false }, 'a live site with no domain is offered the picker');
  assert.deepEqual(view({ siteStatus: 'preview' }), { kind: 'none' });
  assert.deepEqual(view({ siteStatus: 'paused' }), { kind: 'none' });
  assert.deepEqual(view({ buyingOn: false }), { kind: 'none' }, 'nothing is offered when nothing can be bought');
  assert.deepEqual(view({ releasedBefore: true }), { kind: 'none' }, 'after a release the admin decides');
  assert.deepEqual(view({ row: row('needs_choice') }), { kind: 'choose', again: true });
  assert.deepEqual(view({ row: row('needs_choice'), buyingOn: false }), { kind: 'none' });
  for (const s of ['registering', 'connecting'] as const) assert.deepEqual(view({ row: row(s) }), { kind: 'setting_up', name: 'harbourmanagement.co.uk' }, s);
  assert.deepEqual(view({ row: row('live') }), { kind: 'live', address: 'https://harbourmanagement.co.uk/' });
  for (const s of ['awaiting_admin', 'held_cap', 'failed'] as const) assert.deepEqual(view({ row: row(s) }), { kind: 'waiting', name: 'harbourmanagement.co.uk' }, s);
  for (const s of ['releasing', 'released'] as const) assert.deepEqual(view({ row: row(s) }), { kind: 'none' }, s);
});

test('refusals read as plain sentences, and an unknown reason is a generic one', () => {
  for (const r of ['not_live', 'bad_name', 'not_offered', 'offer_expired', 'cannot_choose', 'conflict', 'whatever']) {
    const t = chooseProblemText(r);
    assert.ok(t.length > 10 && /[.]$/.test(t), r);
    assert.doesNotMatch(t, /offer_expired|not_offered|cannot_choose|registrar/);
  }
});
