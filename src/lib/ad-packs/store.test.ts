import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadPath, DOWNLOAD_SECONDS, signedDownloadUrlWith } from './download.ts';
import { parseFiles, parseTexts, sortAds, toAdRow, toPackRow, toRunRow, PACK_COLUMN_OF, PACK_COLUMNS } from './rows.ts';
import { harness, readyVideo } from './test-store.ts';
import type { GenerateOk } from './generate-core.ts';

const OWNER_A = '3f9a2c11-1111-4111-8111-111111111111';
const OWNER_B = '3f9a2c22-2222-4222-8222-222222222222';

const INPUT = {
  areaKey: 'NG7',
  photos: ['https://cdn.example.test/photo-1.jpg'],
  brand: { company: 'Brightstone Stays', logoUrl: 'https://cdn.example.test/logo.png', brandColour: '#1F6F5C', feePct: 12, areas: ['Nottingham'], photoUrl: null },
  domain: 'brightstone.co.uk',
};

async function made() {
  const h = harness();
  const r = (await h.engine.generatePack({ ownerId: OWNER_A, by: 'operator', input: INPUT })) as GenerateOk;
  assert.ok(r.ok);
  const ads = await h.store.listAds(OWNER_A, r.packId);
  return { h, r, ads };
}

// ── Signed downloads ──

test('signedDownloadUrl: the owner gets a short link for a file the ad really has; the path is the stored one', async () => {
  const { h, ads } = await made();
  const ad = ads.find((a) => a.angle === '3a')!;
  const file = ad.files.images[0];
  const signed: { path: string; seconds: number; name: string }[] = [];
  const url = await signedDownloadUrlWith(h.store, async (path, seconds, name) => {
    signed.push({ path, seconds, name });
    return `https://signed.example.test/${path}?t=1`;
  }, OWNER_A, ad.id, file.name);
  assert.equal(url, `https://signed.example.test/${file.path}?t=1`);
  assert.deepEqual(signed, [{ path: file.path, seconds: DOWNLOAD_SECONDS, name: file.name }]);
  assert.ok(DOWNLOAD_SECONDS <= 600, 'short-lived');
});

test('signedDownloadUrl: null for someone else’s pack ad, and the signer is never asked', async () => {
  const { h, ads } = await made();
  const ad = ads.find((a) => a.angle === '3a')!;
  let asked = 0;
  const sign = async () => {
    asked++;
    return 'https://signed.example.test/x';
  };
  assert.equal(await signedDownloadUrlWith(h.store, sign, OWNER_B, ad.id, ad.files.images[0].name), null);
  assert.equal(await downloadPath(h.store, OWNER_B, ad.id, ad.files.images[0].name), null);
  assert.equal(asked, 0);
});

test('signedDownloadUrl: null for a file the ad does not have, a missing ad, empty input, and a path outside the owner’s folder', async () => {
  const { h, ads } = await made();
  const ad = ads.find((a) => a.angle === '17')!;
  const sign = async () => 'https://signed.example.test/x';
  assert.equal(await signedDownloadUrlWith(h.store, sign, OWNER_A, ad.id, 'nope.png'), null);
  assert.equal(await signedDownloadUrlWith(h.store, sign, OWNER_A, ad.id, '../../etc/passwd'), null);
  assert.equal(await signedDownloadUrlWith(h.store, sign, OWNER_A, 'ad-missing', ad.files.images[0].name), null);
  assert.equal(await signedDownloadUrlWith(h.store, sign, OWNER_A, '', 'x.png'), null);
  assert.equal(await signedDownloadUrlWith(h.store, sign, '', ad.id, 'x.png'), null);
  // The 5b ad has no image files at all (its video is "coming").
  const b = ads.find((a) => a.angle === '5b')!;
  assert.equal(await signedDownloadUrlWith(h.store, sign, OWNER_A, b.id, '5b.mp4'), null);
  // A stored path that points outside the owner's folder is not signed even for the owner.
  h.store.ads.get(ad.id)!.files.images[0].path = `${OWNER_B}/other/v1/${ad.files.images[0].name}`;
  assert.equal(await signedDownloadUrlWith(h.store, sign, OWNER_A, ad.id, ad.files.images[0].name), null);
});

// ── The memory store behaves like the SQL ──

test('ad codes are unique and every ad row belongs to its pack’s owner', async () => {
  const { h, r, ads } = await made();
  const dup = ads.map((a) => ({ packId: a.packId, ownerId: a.ownerId, version: a.version, angle: a.angle, n: a.n, code: a.code, adName: a.adName, link: a.link, texts: a.texts, leadForm: a.leadForm, files: a.files }));
  await assert.rejects(h.store.insertAds(OWNER_A, dup), (e: unknown) => (e as { which?: string }).which === 'code');
  assert.equal(h.store.ads.size, 3);
  assert.ok(ads.every((a) => a.ownerId === OWNER_A && a.packId === r.packId));
});

test('runs are listed newest first and only for the owner’s pack; monthSpendPence adds the non-dry cost since the instant', async () => {
  const { h, r } = await made();
  h.now = new Date('2026-11-21T10:00:00Z');
  await h.engine.generatePack({ ownerId: OWNER_A, by: 'admin', input: INPUT });
  const runs = await h.store.listRuns(OWNER_A, r.packId);
  assert.equal(runs.length, 2);
  assert.ok(runs[0].createdAt > runs[1].createdAt);
  assert.equal(await h.store.monthSpendPence('2026-11-21T00:00:00Z'), 0);
  assert.equal(await h.store.monthSpendPence('2026-10-01T00:00:00Z'), 0);
});

// ── Row mappers ──

test('toPackRow: a database row to the typed row, with safe defaults', () => {
  const row = toPackRow({
    id: 'p1', owner_id: 'o1', website_id: null, status: 'preview', operator_code: '3F9A2C', version: 2, voice_key: null, voice_changes: 0, regen_count: '1',
    brand_hash: 'abc', area_key: 'NG7', area_label: 'Lenton, Nottingham', bedrooms: 3, figures: [{ a: 1 }], photos: ['u', 5], checks: { ok: true, failures: [], warnings: [], results: [] },
    error_code: null, cost_pence: 35, generated_at: '2026-11-20T10:00:00Z', approved_at: null, created_at: '2026-11-20T09:00:00Z', updated_at: '2026-11-20T10:00:00Z',
  });
  assert.equal(row.status, 'preview');
  assert.equal(row.regenCount, 1);
  assert.deepEqual(row.photos, ['u']);
  assert.equal(row.checks?.ok, true);
  assert.equal(row.websiteId, null);
  const odd = toPackRow({ id: 'p', owner_id: 'o', status: 'weird', operator_code: 'AAAAAA', created_at: 'c', updated_at: 'u' });
  assert.equal(odd.status, 'failed', 'an unknown status never reads as shown');
  assert.equal(odd.version, 1);
  assert.equal(odd.costPence, 0);
  assert.equal(odd.figures, null);
});

test('parseTexts and parseFiles survive junk', () => {
  assert.deepEqual(parseTexts(null), { primary: [], headlines: [], descriptions: [] });
  assert.deepEqual(parseTexts({ primary: ['a', 1], headlines: 'x', script: 's', cardsText: ['c'] }), { primary: ['a'], headlines: [], descriptions: [], script: 's', cardsText: ['c'] });
  assert.deepEqual(parseFiles(undefined), { images: [], video: null });
  assert.deepEqual(parseFiles({ images: [{ name: 'a.png', path: 'o/p/v1/a.png', width: 1080, height: 1080, bytes: 3 }, { name: 1 }, null], video: { status: 'coming' } }), {
    images: [{ name: 'a.png', path: 'o/p/v1/a.png', width: 1080, height: 1080, contentType: 'image/png', bytes: 3 }],
    video: { status: 'coming' },
  });
  assert.equal(parseFiles({ video: { status: 'ready' } }).video, null);
});

test('parseFiles carries the full video slot (38b): queued, making, failed with a code, and ready with its files', () => {
  assert.deepEqual(parseFiles({ video: { status: 'queued' } }).video, { status: 'queued' });
  assert.deepEqual(parseFiles({ video: { status: 'making' } }).video, { status: 'making' });
  assert.deepEqual(parseFiles({ video: { status: 'failed', code: 'voice_unavailable' } }).video, { status: 'failed', code: 'voice_unavailable' });
  assert.equal(parseFiles({ video: { status: 'nonsense' } }).video, null);
  const ready = readyVideo(OWNER_A, 'p1', 1, 'olivia');
  assert.deepEqual(parseFiles({ images: [], video: ready }).video, ready);
  // A slot read back from a row is exactly what was written (the store writes {images, video}).
  assert.deepEqual(parseFiles(JSON.parse(JSON.stringify({ images: [], video: ready }))), { images: [], video: ready });
});

test('toAdRow, toRunRow and sortAds', () => {
  const ad = toAdRow({ id: 'a', pack_id: 'p', owner_id: 'o', version: 2, angle: '3a', n: 2, code: 'SI-3F9A2C-3A-2', ad_name: 'n', link: 'l', texts: {}, lead_form: null, files: null, superseded_at: null, created_at: 'c' });
  assert.equal(ad.angle, '3a');
  assert.deepEqual(ad.leadForm, []);
  assert.deepEqual(ad.files, { images: [], video: null });
  const run = toRunRow({ id: 'r', pack_id: 'p', version: 1, by: 'admin', dry: false, cost_pence: 12, result: { outcome: 'preview' }, created_at: 'c' });
  assert.equal(run.by, 'admin');
  assert.equal(run.costPence, 12);
  const sorted = sortAds([
    { version: 1, angle: '17' },
    { version: 2, angle: '17' },
    { version: 2, angle: '5b' },
    { version: 2, angle: '3a' },
    { version: 1, angle: '5b' },
  ]);
  assert.deepEqual(sorted.map((a) => `${a.version}${a.angle}`), ['25b', '23a', '217', '15b', '117']);
});

test('the patch map covers every patchable pack column and the column list matches the schema', () => {
  const columns = PACK_COLUMNS.split(',').map((c) => c.trim());
  for (const col of Object.values(PACK_COLUMN_OF)) assert.ok(columns.includes(col), col);
  for (const col of ['id', 'owner_id', 'operator_code', 'created_at', 'updated_at']) assert.ok(columns.includes(col));
  assert.ok(!Object.values(PACK_COLUMN_OF).includes('owner_id') && !Object.values(PACK_COLUMN_OF).includes('operator_code'), 'owner and operator code are never patched');
});
