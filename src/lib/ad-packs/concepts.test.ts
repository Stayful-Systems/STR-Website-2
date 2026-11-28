import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AD_FORMATS, CONCEPT_ID_RE, conceptFor, isAdFormat } from './concepts.ts';
import { ANGLES } from './codes.ts';
import { adInsertRow, toAdRow } from './rows.ts';
import type { NewAd } from './store-types.ts';

/** Batch 55 step 5 (Phase 1, 55c A6): the concept and format on each lead database pack ad. */

test('Phase 1: 5b is the notice video, 3a and 17 the type cards; every concept id fits the column check', () => {
  assert.deepEqual(conceptFor('5b'), { conceptId: '5b-v1', format: 'notice_video' });
  assert.deepEqual(conceptFor('3a'), { conceptId: '3a-v1', format: 'type_cards' });
  assert.deepEqual(conceptFor('17'), { conceptId: '17-v1', format: 'type_cards' });
  for (const a of ANGLES) assert.match(conceptFor(a).conceptId, CONCEPT_ID_RE);
  assert.equal(isAdFormat('loupe'), true);
  assert.equal(isAdFormat('carousel'), false);
});

test('the format list is the schema’s check, word for word', () => {
  const sql = readFileSync(new URL('../../../supabase/schema.sql', import.meta.url), 'utf8');
  const m = /ad_pack_ads_format_check\s+check \(format is null or format in \(([^)]*)\)\)/.exec(sql);
  assert.ok(m, 'the format check is in schema.sql');
  assert.deepEqual(m[1].split(',').map((s) => s.trim().replace(/'/g, '')), [...AD_FORMATS]);
});

const AD: NewAd = {
  packId: 'p1', ownerId: 'o1', version: 1, angle: '5b', n: 1, code: 'SI-ABCDEF-5B-1', adName: 'x', link: 'https://x.test/',
  texts: { primary: [], headlines: [], descriptions: [] }, leadForm: [], files: { images: [], video: null },
};

test('an Academy row is inserted exactly as before (no concept or format column); a lead database row carries both', () => {
  assert.deepEqual(Object.keys(adInsertRow(AD)), ['pack_id', 'owner_id', 'version', 'angle', 'n', 'code', 'ad_name', 'link', 'texts', 'lead_form', 'files']);
  const row = adInsertRow({ ...AD, ...conceptFor('5b') });
  assert.equal(row.concept_id, '5b-v1');
  assert.equal(row.format, 'notice_video');
  const back = toAdRow({ ...row, id: 'a1', created_at: '2026-12-01T00:00:00Z' });
  assert.equal(back.conceptId, '5b-v1');
  assert.equal(back.format, 'notice_video');
  const old = toAdRow({ ...adInsertRow(AD), id: 'a2', created_at: '2026-12-01T00:00:00Z' });
  assert.ok(!('conceptId' in old) && !('format' in old));
});
