import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, type Harness } from '../../../lib/ad-packs/test-store.ts';
import { signedDownloadUrlWith } from '../../../lib/ad-packs/download.ts';
import { PHOTO_MAX_BYTES, uploadRef, MAX_UPLOADS_PER_OWNER } from '../../../lib/ad-packs/photos.ts';
import { buildActivityCall } from '../../../lib/activity/event.ts';
import { approveOp, areaPreviewOp, copyOp, downloadOp, generateOp, MESSAGES, uploadPhotoOp, type AdsDeps, type EligibilityFacts, type Session } from './ops.ts';
import { isCopyKind } from './view.ts';

const OWNER_A = '3f9a2c11-1111-4111-8111-111111111111';
const OWNER_B = '7b1d4e22-2222-4222-8222-222222222222';

const SETTINGS = { companyName: 'Brightstone Stays', logoUrl: 'https://cdn.example.test/logo.png', brandColour: '#1F6F5C', managementFeePct: 12, areas: ['Nottingham'], photoUrl: null };
const ELIGIBLE: EligibilityFacts = { eligible: true, reasons: [], website: { id: 'site-1', settings: SETTINGS }, domain: 'brightstone.co.uk' };

const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 0]);

type Rec = { ownerId: string; kind: string; extras: Record<string, string | number>; dedupeKey?: string };

/** The deps over the in-memory generator: the session is whoever the test says; nothing else is faked. */
function setup(who: Session = { ok: true, ownerId: OWNER_A, email: 'a@example.test', admin: false }) {
  const h: Harness = harness();
  const calls = { eligibility: [] as { userId: string; admin: boolean }[], signed: 0, uploads: [] as string[], generate: 0, approve: 0 };
  const records: Rec[] = [];
  let current: Session = who;
  let eligibility: EligibilityFacts = ELIGIBLE;
  let uploadedCount: number | null = 0;
  let n = 0;
  const deps: AdsDeps = {
    session: async () => current,
    eligibility: async (userId, opts) => {
      calls.eligibility.push({ userId, admin: opts.admin });
      return eligibility;
    },
    areaPreview: async (areaKey) => ({ areaKey, areaLabel: 'Lenton, Nottingham', fellBack: false, bedrooms: 3, samples: 14 }),
    listPack: (ownerId) => h.engine.listPackForOwner(ownerId),
    generate: (req) => {
      calls.generate++;
      return h.engine.generatePack(req);
    },
    approve: (req) => {
      calls.approve++;
      return h.engine.approvePack(req);
    },
    getAd: (ownerId, adId) => h.store.getPackAd(ownerId, adId),
    signDownload: (ownerId, adId, file) =>
      signedDownloadUrlWith(h.store, async (path) => {
        calls.signed++;
        return `https://signed.example.test/${path}`;
      }, ownerId, adId, file),
    upload: async (path, bytes, type) => {
      assert.ok(bytes.length > 0 && type.startsWith('image/'));
      calls.uploads.push(path);
      return { ok: true };
    },
    countUploads: async () => uploadedCount,
    previewUrl: async (_o, path) => `https://preview.example.test/${path}`,
    record: async (ownerId, kind, opts) => {
      records.push({ ownerId, kind, extras: opts.extras, dedupeKey: opts.dedupeKey });
    },
    newId: () => `0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a${String(++n).padStart(2, '0')}`,
  };
  return {
    h,
    deps,
    calls,
    records,
    as: (s: Session) => void (current = s),
    eligible: (e: EligibilityFacts) => void (eligibility = e),
    uploaded: (c: number | null) => void (uploadedCount = c),
  };
}

const owner = (ownerId: string): Session => ({ ok: true, ownerId, email: null, admin: false });
const input = { areaKey: 'NG7', photoRefs: [] as string[], typeOnly: false };

/** Owner A with a made pack. */
async function madePack() {
  const s = setup();
  const out = await generateOp(s.deps, input);
  assert.deepEqual(out, { ok: true });
  const view = await s.h.engine.listPackForOwner(OWNER_A);
  assert.ok(view);
  return { ...s, view: view! };
}

// ── Generate ──

test('generate: the owner, brand and domain come from the session and the owner’s website, never from the form', async () => {
  const s = setup();
  // A form that tries to bring its own owner, brand and domain.
  const forged = { ...input, ownerId: OWNER_B, userId: OWNER_B, company: 'Someone Else', domain: 'evil.co.uk', brand: { company: 'Someone Else' } };
  assert.deepEqual(await generateOp(s.deps, forged), { ok: true });
  assert.equal(await s.h.store.getPack(OWNER_B), null, 'nothing was made for the account the form named');
  const pack = await s.h.store.getPack(OWNER_A);
  assert.ok(pack);
  const ads = await s.h.store.listAds(OWNER_A, pack!.id);
  assert.equal(ads.length, 3);
  assert.ok(ads.every((a) => a.ownerId === OWNER_A));
  assert.ok(ads.every((a) => a.link.startsWith('https://brightstone.co.uk/?ad=')), 'the domain is the owner’s own live domain');
  assert.ok(ads.some((a) => a.texts.primary.join(' ').includes('Brightstone Stays')));
  assert.ok(!ads.some((a) => JSON.stringify(a.texts).includes('Someone Else')));
  assert.deepEqual(s.calls.eligibility, [{ userId: OWNER_A, admin: false }]);
});

test('generate: a team member, a signed-out visitor and an account that is not eligible are refused in plain words, and nothing is made', async () => {
  const s = setup({ ok: false, reason: 'member' });
  assert.deepEqual(await generateOp(s.deps, input), { error: MESSAGES.member });
  s.as({ ok: false, reason: 'signed_out' });
  assert.deepEqual(await generateOp(s.deps, input), { error: MESSAGES.signed_out });
  s.as(owner(OWNER_A));
  s.eligible({ eligible: false, reasons: ['site_not_live'] });
  const out = await generateOp(s.deps, input);
  assert.match(out.error ?? '', /not live yet/);
  assert.doesNotMatch(out.error ?? '', /site_not_live/);
  assert.equal(s.calls.generate, 0);
});

test('generate: another owner’s pack id is refused before anything is made', async () => {
  const a = await madePack();
  const before = a.h.renderer.calls.length;
  // Owner B (eligible, with their own site) names owner A's pack.
  a.as(owner(OWNER_B));
  const out = await generateOp(a.deps, { ...input, packId: a.view.pack.id });
  assert.deepEqual(out, { error: MESSAGES.not_found });
  assert.equal(a.h.renderer.calls.length, before, 'no image was rendered');
  assert.equal(await a.h.store.getPack(OWNER_B), null);
  // A pack id for a pack that does not exist is refused the same way, and the owner's own id is accepted.
  assert.deepEqual(await generateOp(a.deps, { ...input, packId: '00000000-0000-4000-8000-000000000000' }), { error: MESSAGES.not_found });
  a.as(owner(OWNER_A));
  const own = await generateOp(a.deps, { ...input, packId: a.view.pack.id });
  assert.equal(own.ok, undefined, 'the owner’s own pack id is only a key: the free regeneration rule then says no change');
  assert.match(own.error ?? '', /not changed/);
});

test('generate: photo references must be the owner’s own uploads; web addresses and other owners’ files are refused', async () => {
  const s = setup();
  const mine = uploadRef(OWNER_A, '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a01', 'jpg');
  const theirs = uploadRef(OWNER_B, '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a02', 'jpg');
  for (const photoRefs of [[theirs], ['https://cdn.example.test/p.jpg'], [mine, theirs], 'not-a-list']) {
    assert.deepEqual(await generateOp(s.deps, { ...input, photoRefs }), { error: MESSAGES.photos });
  }
  assert.equal(s.calls.generate, 0);
  assert.deepEqual(await generateOp(s.deps, { ...input, photoRefs: [mine] }), { ok: true });
  assert.deepEqual((await s.h.store.getPack(OWNER_A))!.photos, [mine], 'the stored reference is what the generator keeps');
});

test('generate: an area that is not a postcode area or district is refused', async () => {
  const s = setup();
  for (const areaKey of [undefined, '', 'Nottingham', '12345', 'NG7 2AB!']) assert.deepEqual(await generateOp(s.deps, { ...input, areaKey }), { error: MESSAGES.area });
  assert.equal(s.calls.generate, 0);
});

test('generate: a missing company name or colour stops it with a plain sentence; a missing logo needs the type-only tick', async () => {
  const s = setup();
  s.eligible({ ...ELIGIBLE, website: { id: 'site-1', settings: { ...SETTINGS, companyName: '  ' } } });
  assert.match((await generateOp(s.deps, input)).error ?? '', /no company name/);
  s.eligible({ ...ELIGIBLE, website: { id: 'site-1', settings: { ...SETTINGS, brandColour: null } } });
  assert.match((await generateOp(s.deps, input)).error ?? '', /no brand colour/);
  s.eligible({ ...ELIGIBLE, website: { id: 'site-1', settings: { ...SETTINGS, logoUrl: null } } });
  assert.match((await generateOp(s.deps, input)).error ?? '', /tick the box/);
  assert.equal(s.calls.generate, 0);
  assert.deepEqual(await generateOp(s.deps, { ...input, typeOnly: true }), { ok: true });
});

test('generate: a refusal from the generator is its plain message, never a code', async () => {
  const s = setup();
  s.h.area.result = { error: 'not_enough_data' };
  const out = await generateOp(s.deps, input);
  assert.equal(out.error, 'There is not enough data in your area yet.');
  assert.doesNotMatch(out.error ?? '', /not_enough_data/);
});

// ── Approve ──

test('approve: logs ad_pack_approved once the pack is approved, with the version and a dedupe key, nothing else', async () => {
  const a = await madePack();
  const out = await approveOp(a.deps, { packId: a.view.pack.id });
  assert.equal(out.ok, true);
  assert.equal((await a.h.store.getPack(OWNER_A))!.status, 'approved');
  assert.equal(a.records.length, 1);
  assert.equal(a.records[0].kind, 'ad_pack_approved');
  assert.equal(a.records[0].ownerId, OWNER_A);
  assert.deepEqual(a.records[0].extras, { version: 1 });
  assert.equal(a.records[0].dedupeKey, `ad_pack_approved:${a.view.pack.id}:v1`);
  // Approving again is refused and logs nothing more.
  const again = await approveOp(a.deps, { packId: a.view.pack.id });
  assert.ok(again.error);
  assert.equal(a.records.length, 1);
});

test('approve: another owner’s pack id is refused: nothing is approved and nothing is logged', async () => {
  const a = await madePack();
  a.as(owner(OWNER_B));
  const out = await approveOp(a.deps, { packId: a.view.pack.id });
  assert.deepEqual(out, { error: MESSAGES.not_found });
  assert.equal(a.calls.approve, 0, 'the generator was never asked');
  assert.equal((await a.h.store.getPack(OWNER_A))!.status, 'preview');
  assert.equal(a.records.length, 0);
  // No pack id, or a made-up one, is refused the same way, even for the owner.
  a.as(owner(OWNER_A));
  for (const packId of [undefined, '', 42, '00000000-0000-4000-8000-000000000000']) assert.deepEqual(await approveOp(a.deps, { packId }), { error: MESSAGES.not_found });
  assert.equal(a.calls.approve, 0);
  assert.equal(a.records.length, 0);
});

test('approve: a team member and an account that is not eligible cannot approve', async () => {
  const a = await madePack();
  a.as({ ok: false, reason: 'member' });
  assert.deepEqual(await approveOp(a.deps, { packId: a.view.pack.id }), { error: MESSAGES.member });
  a.as(owner(OWNER_A));
  a.eligible({ eligible: false, reasons: ['domain_not_live'] });
  assert.match((await approveOp(a.deps, { packId: a.view.pack.id })).error ?? '', /not live yet/);
  assert.equal(a.calls.approve, 0);
  assert.equal(a.records.length, 0);
});

// ── Download ──

test('download: the owner gets a link for a file their ad has; another owner’s ad id is refused and nothing is signed', async () => {
  const a = await madePack();
  const ad = a.view.ads.find((x) => x.angle === '3a')!;
  const file = ad.files.images[0];
  const ok = await downloadOp(a.deps, { adId: ad.id, fileName: file.name });
  assert.deepEqual(ok, { ok: true, url: `https://signed.example.test/${file.path}` });
  assert.equal(a.calls.signed, 1);

  a.as(owner(OWNER_B));
  const refused = await downloadOp(a.deps, { adId: ad.id, fileName: file.name });
  assert.deepEqual(refused, { ok: false, error: MESSAGES.download });
  assert.equal(a.calls.signed, 1, 'the signer was not asked for another owner’s file');

  a.as(owner(OWNER_A));
  for (const bad of [{ adId: ad.id, fileName: 'nope.png' }, { adId: ad.id, fileName: '../../x.png' }, { adId: 'ad-missing', fileName: file.name }, { adId: '', fileName: file.name }, { adId: ad.id }, {}]) {
    assert.equal((await downloadOp(a.deps, bad)).ok, false);
  }
  a.as({ ok: false, reason: 'signed_out' });
  assert.deepEqual(await downloadOp(a.deps, { adId: ad.id, fileName: file.name }), { ok: false, error: MESSAGES.signed_out });
});

// ── Copy ──

test('copy: logs ad_text_copied with the ad code, angle, kind and position, and never the text', async () => {
  const a = await madePack();
  const ad = a.view.ads.find((x) => x.angle === '3a')!;
  const out = await copyOp(a.deps, { adId: ad.id, kind: 'headline', index: 2 });
  assert.deepEqual(out, { ok: true });
  assert.equal(a.records.length, 1);
  const rec = a.records[0];
  assert.equal(rec.kind, 'ad_text_copied');
  assert.deepEqual(rec.extras, { ad: ad.code, angle: '3a', kind: 'headline', n: 3 });
  // Not one text of any ad (or the name or the link) is in what was logged.
  const logged = JSON.stringify(rec);
  for (const t of [ad.adName, ad.link, ...ad.texts.primary, ...ad.texts.headlines, ...ad.texts.descriptions]) assert.ok(!logged.includes(t), t);
  // What was logged survives the activity log's own cleaning: the ad code is not mistaken for something it drops.
  const call = buildActivityCall(OWNER_A, rec.kind, { extras: rec.extras }, { now: new Date('2026-11-20T10:00:00Z'), env: 'production', background: true });
  assert.deepEqual(call?.extras, { ad: ad.code, angle: '3a', kind: 'headline', n: 3 });
  assert.equal(call?.counted, false);
});

test('copy: the name, the link and every kind of text can be logged; an index the ad does not have is refused', async () => {
  const a = await madePack();
  const ad = a.view.ads[0];
  for (const [kind, index] of [['name', 0], ['link', 0], ['primary', 0], ['headline', 0], ['description', 0]] as const) assert.deepEqual(await copyOp(a.deps, { adId: ad.id, kind, index }), { ok: true });
  assert.equal(a.records.length, 5);
  const n = a.records.length;
  for (const bad of [{ kind: 'headline', index: 99 }, { kind: 'name', index: 1 }, { kind: 'headline', index: -1 }, { kind: 'headline', index: 1.5 }, { kind: 'script', index: 0 }, { kind: 'headline', index: '0' }, { kind: 7, index: 0 }]) {
    assert.deepEqual(await copyOp(a.deps, { adId: ad.id, ...bad }), { ok: false });
  }
  assert.equal(a.records.length, n);
  assert.ok(isCopyKind('link') && !isCopyKind('script'));
});

test('copy: another owner’s ad id is refused and nothing is logged', async () => {
  const a = await madePack();
  const ad = a.view.ads[0];
  a.as(owner(OWNER_B));
  assert.deepEqual(await copyOp(a.deps, { adId: ad.id, kind: 'headline', index: 0 }), { ok: false });
  a.as({ ok: false, reason: 'member' });
  assert.deepEqual(await copyOp(a.deps, { adId: ad.id, kind: 'headline', index: 0 }), { ok: false });
  assert.deepEqual(await copyOp({ ...a.deps, session: async () => owner(OWNER_A) }, { adId: 'ad-missing', kind: 'headline', index: 0 }), { ok: false });
  assert.equal(a.records.length, 0);
});

// ── Photos ──

test('upload: a JPEG or PNG goes into the owner’s own uploads folder and comes back as a reference with a preview', async () => {
  const s = setup();
  const out = await uploadPhotoOp(s.deps, { bytes: JPG, declaredType: 'image/jpeg' });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.ref, `${OWNER_A}/uploads/0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a01.jpg`);
  assert.deepEqual(s.calls.uploads, [out.ref]);
  assert.equal(out.previewUrl, `https://preview.example.test/${out.ref}`);
});

test('upload: the type, size and first bytes are checked on the server, and a team member or full folder is refused', async () => {
  const s = setup();
  const text = new TextEncoder().encode('<html>not a photo</html>');
  const big = new Uint8Array(PHOTO_MAX_BYTES + 1);
  big.set(JPG);
  for (const [bytes, declaredType] of [[text, 'image/jpeg'], [JPG, 'image/png'], [JPG, 'text/html'], [JPG, null], [big, 'image/jpeg'], [new Uint8Array(0), 'image/jpeg'], [null, 'image/jpeg']] as const) {
    assert.equal((await uploadPhotoOp(s.deps, { bytes: bytes as Uint8Array | null, declaredType })).ok, false);
  }
  assert.deepEqual(s.calls.uploads, [], 'nothing was stored');
  s.uploaded(MAX_UPLOADS_PER_OWNER);
  assert.equal((await uploadPhotoOp(s.deps, { bytes: JPG, declaredType: 'image/jpeg' })).ok, false);
  s.uploaded(null);
  assert.equal((await uploadPhotoOp(s.deps, { bytes: JPG, declaredType: 'image/jpeg' })).ok, false);
  s.as({ ok: false, reason: 'member' });
  assert.deepEqual(await uploadPhotoOp(s.deps, { bytes: JPG, declaredType: 'image/jpeg' }), { ok: false, error: MESSAGES.member });
  assert.deepEqual(s.calls.uploads, []);
});

// ── The area step ──

test('area preview: a bad area key is refused, a good one gives the bedroom sentence', async () => {
  const s = setup();
  assert.equal((await areaPreviewOp(s.deps, { areaKey: 'nope!' })).ok, false);
  assert.equal((await areaPreviewOp(s.deps, {})).ok, false);
  const out = await areaPreviewOp(s.deps, { areaKey: 'NG7' });
  assert.equal(out.ok, true);
  assert.equal(out.bedrooms, 3);
  assert.match(out.text, /typical 3-bed/);
  s.as({ ok: false, reason: 'signed_out' });
  assert.equal((await areaPreviewOp(s.deps, { areaKey: 'NG7' })).ok, false);
});
