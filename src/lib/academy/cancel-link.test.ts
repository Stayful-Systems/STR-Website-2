import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signWith, expiringPayload } from '../crypto/sign.ts';
import { academyCancelTokenWith, academyCancelUrl, verifyAcademyCancelToken, verifyAcademyCancelTokenWith } from './cancel-link.ts';

const KEY = 'a-test-signing-key-that-is-long-enough';
const now = new Date('2026-11-19T10:00:00Z');
const trialEnd = new Date('2027-02-17T10:00:00Z');

test('a token verifies for its subscription until the trial ends', () => {
  const token = academyCancelTokenWith(KEY, 'sub_ABC123', trialEnd);
  assert.deepEqual(verifyAcademyCancelTokenWith(KEY, token, now), { subId: 'sub_ABC123' });
  assert.deepEqual(verifyAcademyCancelTokenWith(KEY, token, new Date(trialEnd.getTime() - 1000)), { subId: 'sub_ABC123' });
  assert.equal(verifyAcademyCancelTokenWith(KEY, token, new Date(trialEnd.getTime() + 1000)), null);
});

test('a token is refused under another key, for another subscription, or tampered with', () => {
  const token = academyCancelTokenWith(KEY, 'sub_ABC123', trialEnd);
  const [, exp, sig] = token.split('.');
  assert.equal(verifyAcademyCancelTokenWith('another-key-that-is-also-long', token, now), null);
  assert.equal(verifyAcademyCancelTokenWith(KEY, `sub_OTHER.${exp}.${sig}`, now), null);
  assert.equal(verifyAcademyCancelTokenWith(KEY, `sub_ABC123.${Number(exp) + 86400}.${sig}`, now), null);
  for (const bad of [null, undefined, '', 'nonsense', 'sub_ABC123.abc.sig', 'cus_1.1900000000.sig', `${token}.x`]) {
    assert.equal(verifyAcademyCancelTokenWith(KEY, bad, now), null);
  }
});

test('another signed URL (the deal photo id:exp form) cannot stand in for a cancel link', () => {
  const exp = Math.floor(trialEnd.getTime() / 1000);
  const photoSig = signWith(KEY, expiringPayload('sub_ABC123', exp));
  assert.equal(verifyAcademyCancelTokenWith(KEY, `sub_ABC123.${exp}.${photoSig}`, now), null);
});

test('the env helpers sign with the configured key; without one the link is Account → Billing', () => {
  const saved = { photo: process.env.DEALS_PHOTO_SECRET, internal: process.env.INTERNAL_API_SECRET, site: process.env.NEXT_PUBLIC_SITE_URL };
  try {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://example.test';
    delete process.env.DEALS_PHOTO_SECRET;
    delete process.env.INTERNAL_API_SECRET;
    assert.equal(academyCancelUrl('sub_ABC123', trialEnd), 'https://example.test/account/billing');

    process.env.INTERNAL_API_SECRET = KEY;
    const url = new URL(academyCancelUrl('sub_ABC123', trialEnd));
    assert.equal(url.origin + url.pathname, 'https://example.test/api/billing/academy/cancel');
    const t = url.searchParams.get('t');
    assert.equal(t, academyCancelTokenWith(KEY, 'sub_ABC123', trialEnd));
    assert.deepEqual(verifyAcademyCancelToken(t, now), { subId: 'sub_ABC123' });
    assert.equal(verifyAcademyCancelToken(t, new Date(trialEnd.getTime() + 1000)), null);
  } finally {
    for (const [k, v] of [['DEALS_PHOTO_SECRET', saved.photo], ['INTERNAL_API_SECRET', saved.internal], ['NEXT_PUBLIC_SITE_URL', saved.site]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
