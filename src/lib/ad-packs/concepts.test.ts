import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AD_FORMATS, CONCEPT_ID_RE, FALLBACK_FORMAT, conceptFor, isAdFormat } from './concepts.ts';
import { ldConceptFor } from './ld-angles.ts';
import { ANGLES } from './codes.ts';
import { adInsertRow, toAdRow } from './rows.ts';
import type { NewAd } from './store-types.ts';

/** Batch 55 step 5 (Phase 1, 55c A6): the concept and format on each lead database pack ad. */

test('Phase 2: 5b is the phone recording, 3a the report carousel, 17 the loupe; every concept id fits the column check', () => {
  assert.deepEqual(conceptFor('5b'), { conceptId: '5b-tenant-leaving', format: 'phone_recording' });
  assert.deepEqual(conceptFor('3a'), { conceptId: '3a-moving-abroad', format: 'report_carousel' });
  assert.deepEqual(conceptFor('17'), { conceptId: '17-rules-changed', format: 'loupe' });
  for (const a of ANGLES) assert.deepEqual(conceptFor(a), ldConceptFor(a));
  assert.deepEqual(FALLBACK_FORMAT, { '5b': 'notice_video', '3a': 'type_cards', '17': 'type_cards' });
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
  assert.equal(row.concept_id, '5b-tenant-leaving');
  assert.equal(row.format, 'phone_recording');
  const back = toAdRow({ ...row, id: 'a1', created_at: '2026-12-01T00:00:00Z' });
  assert.equal(back.conceptId, '5b-tenant-leaving');
  assert.equal(back.format, 'phone_recording');
  const old = toAdRow({ ...adInsertRow(AD), id: 'a2', created_at: '2026-12-01T00:00:00Z' });
  assert.ok(!('conceptId' in old) && !('format' in old));
});
