import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attributeRow } from './attribute.ts';
import type { AttributeContext } from './attribute.ts';

const OWNER = 'owner-1';
const OTHER = 'owner-2';
const AD = { id: 'ad-5b', code: 'SI-3F9A2C-5B-1', ownerId: OWNER, version: 1 };
const FOREIGN_AD = { id: 'ad-x', code: 'SI-AAAAAA-5B-1', ownerId: OTHER, version: 1 };

const ctx = (known: [string, string][] = []): AttributeContext => ({
  ownerId: OWNER,
  operatorCode: '3F9A2C',
  packAds: [AD, FOREIGN_AD],
  knownMetaAdIds: new Map(known),
});

test('a code in the ad name attributes to the pack ad', () => {
  const r = attributeRow(ctx(), { adName: 'SI-3F9A2C-5B-1 · Tenant notice', adId: '120001' });
  assert.equal(r.match, 'code');
  assert.equal(r.packAdId, 'ad-5b');
  assert.equal(r.foreign, false);
  assert.deepEqual(r.link('lead-1'), {
    lead_id: 'lead-1',
    owner_id: OWNER,
    pack_ad_id: 'ad-5b',
    match: 'code',
    ad_code_seen: 'SI-3F9A2C-5B-1',
    meta_ad_id_seen: '120001',
  });
});

test('a renamed ad (no code) attributes through an id learned earlier in the same run', () => {
  const c = ctx();
  const renamed = { adName: 'Landlords: new name', adId: '120001' };
  assert.equal(attributeRow(c, renamed).match, 'none');
  attributeRow(c, { adName: 'SI-3F9A2C-5B-1 · Tenant notice', adId: '120001' });
  const r = attributeRow(c, renamed);
  assert.equal(r.match, 'ad_id');
  assert.equal(r.packAdId, 'ad-5b');
  assert.equal(r.link('l2').pack_ad_id, 'ad-5b');
});

test('an id from an earlier run (ad_pack_lead_links) works the same', () => {
  const r = attributeRow(ctx([['120001', 'ad-5b']]), { adName: null, adId: '120001' });
  assert.equal(r.match, 'ad_id');
});

test('an unknown code of ours is untagged, and the id fallback still applies', () => {
  const none = attributeRow(ctx(), { adName: 'SI-3F9A2C-5B-9 · Old', adId: '555' });
  assert.equal(none.match, 'none');
  assert.equal(none.packAdId, null);
  assert.equal(none.foreign, false);
  assert.equal(none.adCodeSeen, 'SI-3F9A2C-5B-9');
  const viaId = attributeRow(ctx([['555', 'ad-5b']]), { adName: 'SI-3F9A2C-5B-9 · Old', adId: '555' });
  assert.equal(viaId.match, 'ad_id');
  assert.equal(viaId.packAdId, 'ad-5b');
});

test('another operator is foreign, never attributed, and never learned', () => {
  for (const name of ['SI-AAAAAA-5B-1 · Theirs', 'SI-BBBBBB-3A-2 · Unknown theirs']) {
    const c = ctx();
    const r = attributeRow(c, { adName: name, adId: '777' });
    assert.equal(r.match, 'foreign_code');
    assert.equal(r.foreign, true);
    assert.equal(r.packAdId, null);
    assert.equal(r.link('l').pack_ad_id, null);
    assert.equal(c.knownMetaAdIds.size, 0);
    // a foreign code is not rescued by a known id
    assert.equal(attributeRow(ctx([['777', 'ad-5b']]), { adName: name, adId: '777' }).foreign, true);
  }
});

test('no code and no id is untagged; a placeholder id is ignored', () => {
  const r = attributeRow(ctx(), { adName: 'Some ad', adId: '{{ad.id}}' });
  assert.equal(r.match, 'none');
  assert.equal(r.metaAdIdSeen, null);
});
