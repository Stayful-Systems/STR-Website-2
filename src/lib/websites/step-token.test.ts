import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expiringPayload, signWith } from '../crypto/sign.ts';
import { STEP_TOKEN_PURPOSE, STEP_TOKEN_TTL_SECONDS, issueStepToken, readStepToken } from './step-token.ts';

const KEY = 'test-signing-key-0123456789abcdef';
const LEAD = '11111111-1111-4111-8111-111111111111';
const OTHER_LEAD = '22222222-2222-4222-8222-222222222222';
const SITE = '33333333-3333-4333-8333-333333333333';
const OTHER_SITE = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-11-19T10:00:00.000Z');

const issue = (now = NOW) => issueStepToken({ leadId: LEAD, websiteId: SITE }, { key: KEY, now });

test('round trip: the token names the lead and the website it was issued for', () => {
  const token = issue();
  assert.ok(token);
  assert.deepEqual(readStepToken(token, { key: KEY, now: NOW }), { leadId: LEAD, websiteId: SITE });
});

test('the token lasts 30 minutes and not a second more', () => {
  assert.equal(STEP_TOKEN_TTL_SECONDS, 30 * 60);
  const token = issue();
  const at = (s: number) => new Date(NOW.getTime() + s * 1000);
  assert.ok(readStepToken(token, { key: KEY, now: at(STEP_TOKEN_TTL_SECONDS - 1) }));
  assert.equal(readStepToken(token, { key: KEY, now: at(STEP_TOKEN_TTL_SECONDS + 2) }), null);
  assert.equal(readStepToken(token, { key: KEY, now: at(24 * 3600) }), null);
});

test('tampered: a changed signature, expiry or id is refused', () => {
  const [lead, site, exp, sig] = issue()!.split('.');
  const read = (t: string) => readStepToken(t, { key: KEY, now: NOW });
  assert.equal(read([lead, site, exp, sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A')].join('.')), null);
  assert.equal(read([lead, site, String(Number(exp) + 3600), sig].join('.')), null, 'a longer expiry cannot be bought');
  assert.equal(read([lead, site, exp].join('.')), null);
  assert.equal(read([lead, site, exp, sig, 'x'].join('.')), null);
  assert.equal(read(''), null);
  assert.equal(read(`${issue()}${'a'.repeat(400)}`), null);
  assert.equal(readStepToken(undefined, { key: KEY, now: NOW }), null);
  assert.equal(readStepToken({ token: issue() }, { key: KEY, now: NOW }), null);
});

test('wrong key: another signer cannot make a token that passes', () => {
  assert.equal(readStepToken(issue(), { key: 'another-signing-key-0123456789abcdef', now: NOW }), null);
});

test('wrong purpose: a signature made for another purpose does not pass', () => {
  const exp = Math.floor(NOW.getTime() / 1000) + 600;
  // Same lead and website, signed with the same key, but under a different purpose.
  for (const prefix of ['', 'deal-photo:', 'website-step', 'website-step-x:']) {
    const sig = signWith(KEY, expiringPayload(`${prefix}${LEAD}:${SITE}`, exp));
    assert.equal(readStepToken(`${LEAD}.${SITE}.${exp}.${sig}`, { key: KEY, now: NOW }), null, `prefix "${prefix}"`);
  }
  // And the right purpose does pass, so the loop above proves the prefix matters.
  const good = signWith(KEY, expiringPayload(`${STEP_TOKEN_PURPOSE}${LEAD}:${SITE}`, exp));
  assert.ok(readStepToken(`${LEAD}.${SITE}.${exp}.${good}`, { key: KEY, now: NOW }));
});

test('wrong lead or website: a token cannot be moved to another lead or site', () => {
  const [, , exp, sig] = issue()!.split('.');
  assert.equal(readStepToken([OTHER_LEAD, SITE, exp, sig].join('.'), { key: KEY, now: NOW }), null);
  assert.equal(readStepToken([LEAD, OTHER_SITE, exp, sig].join('.'), { key: KEY, now: NOW }), null);
  // Each token names its own lead.
  const other = issueStepToken({ leadId: OTHER_LEAD, websiteId: SITE }, { key: KEY, now: NOW });
  assert.deepEqual(readStepToken(other, { key: KEY, now: NOW }), { leadId: OTHER_LEAD, websiteId: SITE });
});

test('no token for ids that are not ids, and none without a signing key', () => {
  assert.equal(issueStepToken({ leadId: 'nope', websiteId: SITE }, { key: KEY }), null);
  assert.equal(issueStepToken({ leadId: LEAD, websiteId: '../x' }, { key: KEY }), null);
  const saved = { a: process.env.DEALS_PHOTO_SECRET, b: process.env.INTERNAL_API_SECRET };
  delete process.env.DEALS_PHOTO_SECRET;
  delete process.env.INTERNAL_API_SECRET;
  try {
    assert.equal(issueStepToken({ leadId: LEAD, websiteId: SITE }), null, 'fails closed');
    assert.equal(readStepToken(issue()), null, 'and reads nothing');
  } finally {
    if (saved.a !== undefined) process.env.DEALS_PHOTO_SECRET = saved.a;
    if (saved.b !== undefined) process.env.INTERNAL_API_SECRET = saved.b;
  }
});

test('the environment key works end to end', () => {
  const saved = process.env.INTERNAL_API_SECRET;
  process.env.INTERNAL_API_SECRET = 'env-signing-key-0123456789abcdef';
  try {
    const token = issueStepToken({ leadId: LEAD, websiteId: SITE });
    assert.ok(token);
    assert.deepEqual(readStepToken(token), { leadId: LEAD, websiteId: SITE });
  } finally {
    if (saved === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = saved;
  }
});

test('source pin: built on sign.ts, with the purpose prefix; nothing that logs or stores', () => {
  const src = readFileSync(new URL('./step-token.ts', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /from '\.\.\/crypto\/sign\.ts'/);
  assert.match(code, /STEP_TOKEN_PURPOSE = 'website-step:'/);
  assert.doesNotMatch(code, /console\.|cookies|localStorage|sessionStorage|headers/);
});
