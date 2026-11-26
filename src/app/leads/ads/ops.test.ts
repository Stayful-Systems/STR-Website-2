import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, type Harness } from '../../../lib/ad-packs/test-store.ts';
import { signedDownloadUrlWith } from '../../../lib/ad-packs/download.ts';
import { PHOTO_MAX_BYTES, uploadRef, MAX_UPLOADS_PER_OWNER } from '../../../lib/ad-packs/photos.ts';
import { buildActivityCall } from '../../../lib/activity/event.ts';
import { approveOp, areaPreviewOp, changeVoiceOp, copyOp, downloadOp, generateOp, MESSAGES, pollPackOp, retryVideoOp, uploadPhotoOp, videoUrlOp, type AdsDeps, type EligibilityFacts, type Session } from './ops.ts';
import { isCopyKind, PLAIN_CODES, VOICE_UNAVAILABLE_TEXT } from './view.ts';
import { VIDEO_ACTION_CODES } from '../../../lib/ad-packs/generate-core.ts';

const OWNER_A = '3f9a2c11-1111-4111-8111-111111111111';
const OWNER_B = '7b1d4e22-2222-4222-8222-222222222222';

const SETTINGS = { companyName: 'Brightstone Stays', logoUrl: 'https://cdn.example.test/logo.png', brandColour: '#1F6F5C', managementFeePct: 12, areas: ['Nottingham'], photoUrl: null };
const ELIGIBLE: EligibilityFacts = { eligible: true, reasons: [], website: { id: 'site-1', settings: SETTINGS }, domain: 'brightstone.co.uk' };

const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 0]);

type GenerateRequestLike = { ownerId: string; input: { voiceKey?: string; route?: string; sitePath?: string; domain?: string } };

type Rec = { ownerId: string; kind: string; extras: Record<string, string | number>; dedupeKey?: string };

/** The deps over the in-memory generator: the session is whoever the test says; nothing else is faked. */
function setup(who: Session = { ok: true, ownerId: OWNER_A, email: 'a@example.test', admin: false }) {
  const h: Harness = harness();
  const calls = { eligibility: [] as { userId: string; admin: boolean }[], signed: 0, uploads: [] as string[], generate: 0, approve: 0, changeVoice: [] as { ownerId: string; voiceKey: string; expectedVersion?: number }[], retry: [] as { ownerId: string; expectedVersion?: number }[], generated: [] as GenerateRequestLike[] };
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
      calls.generated.push(req);
      return h.engine.generatePack(req);
    },
    approve: (req) => {
      calls.approve++;
      return h.engine.approvePack(req);
    },
    changeVoice: (req) => {
      calls.changeVoice.push(req);
      return h.engine.changeVoice(req);
    },
    retryVideo: (req) => {
      calls.retry.push(req);
      return h.engine.retryVideo(req);
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
  assert.match(own.error ?? '', /Nothing has changed/);
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
  assert.equal(out.error, 'We do not have enough information for that area yet. Please try a bigger area nearby.');
  assert.doesNotMatch(out.error ?? '', /not_enough_data/);
});

// ── Approve ──

test('approve: logs ad_pack_approved once the pack is approved, with the version and a dedupe key, nothing else', async () => {
  const a = await madePack();
  await a.h.finishVideo(OWNER_A); // 38b: a pack is approved only with its video ready
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

test('approve: the version on screen is passed on, so a pack that moved on is not approved unseen', async () => {
  const a = await madePack();
  const stale = await approveOp(a.deps, { packId: a.view.pack.id, version: '99' });
  assert.ok(stale.error);
  assert.equal(a.records.length, 0);
});

test('area step: an account that is not eligible gets the plain reason, not the market data', async () => {
  const a = await madePack();
  a.eligible({ eligible: false, reasons: ['domain_not_live'] });
  const r = await areaPreviewOp(a.deps, { areaKey: 'NG7' });
  assert.equal(r.ok, false);
  assert.match(r.text, /not live yet/);
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

// ── The voice (38b) ──

test('generate: the voice picked is passed to the generator; none picked uses the default; an unknown one is refused before anything is made', async () => {
  const s = setup();
  assert.deepEqual(await generateOp(s.deps, { ...input, voiceKey: 'olivia' }), { ok: true });
  assert.equal(s.calls.generated[0].input.voiceKey, 'olivia');
  assert.equal((await s.h.store.getPack(OWNER_A))!.voiceKey, 'olivia');

  const t = setup();
  assert.deepEqual(await generateOp(t.deps, input), { ok: true });
  assert.equal(t.calls.generated[0].input.voiceKey, undefined, 'a regenerate or an old form sends none');
  assert.equal((await t.h.store.getPack(OWNER_A))!.voiceKey, 'jane');

  const u = setup();
  for (const voiceKey of ['nova', 'JANE', 7, {}, ['jane']]) assert.deepEqual(await generateOp(u.deps, { ...input, voiceKey }), { error: MESSAGES.voice });
  assert.equal(u.calls.generate, 0);
  // A blank or missing field is "no choice", not a refusal.
  assert.deepEqual(await generateOp(u.deps, { ...input, voiceKey: '' }), { ok: true });
});

/** A made pack whose video is ready, with its pack id and version on screen. */
async function readyPack() {
  const a = await madePack();
  await a.h.finishVideo(OWNER_A);
  return a;
}

test('change voice: the version on screen is passed through, the video is made again and the allowance is counted', async () => {
  const a = await readyPack();
  const out = await changeVoiceOp(a.deps, { packId: a.view.pack.id, voiceKey: 'oliver', version: '1' });
  assert.equal(out.ok, true);
  assert.match(out.notice ?? '', /made again with the new voice/);
  assert.deepEqual(a.calls.changeVoice, [{ ownerId: OWNER_A, voiceKey: 'oliver', expectedVersion: 1 }]);
  const pack = (await a.h.store.getPack(OWNER_A))!;
  assert.equal(pack.voiceKey, 'oliver');
  assert.equal(pack.voiceChanges, 1);
  const view = (await a.h.engine.listPackForOwner(OWNER_A))!;
  assert.equal(view.video.status, 'queued', 'the video is being made again');
  // The one change is used: a second is refused in plain words.
  await a.h.finishVideo(OWNER_A);
  const second = await changeVoiceOp(a.deps, { packId: a.view.pack.id, voiceKey: 'olivia', version: '1' });
  assert.equal(second.error, 'You have already used your voice change.');
});

test('change voice: another owner’s pack, a missing or made-up pack id, and a missing or stale version are refused before the generator is asked', async () => {
  const a = await readyPack();
  a.as(owner(OWNER_B));
  assert.deepEqual(await changeVoiceOp(a.deps, { packId: a.view.pack.id, voiceKey: 'oliver', version: '1' }), { error: MESSAGES.not_found });
  a.as(owner(OWNER_A));
  for (const packId of [undefined, '', 42, '00000000-0000-4000-8000-000000000000']) assert.deepEqual(await changeVoiceOp(a.deps, { packId, voiceKey: 'oliver', version: '1' }), { error: MESSAGES.not_found });
  for (const version of [undefined, '', 'x', '-1', '1.5', null]) assert.deepEqual(await changeVoiceOp(a.deps, { packId: a.view.pack.id, voiceKey: 'oliver', version }), { error: MESSAGES.not_found });
  assert.equal(a.calls.changeVoice.length, 0);
  // A version that moved on is the generator's refusal, in plain words, and changes nothing.
  const stale = await changeVoiceOp(a.deps, { packId: a.view.pack.id, voiceKey: 'oliver', version: '9' });
  assert.match(stale.error ?? '', /moved on since you opened/);
  assert.equal((await a.h.store.getPack(OWNER_A))!.voiceChanges, 0);
});

test('change voice: a voice that is not one of the three, a team member, a signed-out visitor and an account that is not eligible are refused', async () => {
  const a = await readyPack();
  for (const voiceKey of [undefined, '', 'nova', 7]) assert.deepEqual(await changeVoiceOp(a.deps, { packId: a.view.pack.id, voiceKey, version: '1' }), { error: MESSAGES.voice });
  a.as({ ok: false, reason: 'member' });
  assert.deepEqual(await changeVoiceOp(a.deps, { packId: a.view.pack.id, voiceKey: 'oliver', version: '1' }), { error: MESSAGES.member });
  a.as({ ok: false, reason: 'signed_out' });
  assert.deepEqual(await changeVoiceOp(a.deps, { packId: a.view.pack.id, voiceKey: 'oliver', version: '1' }), { error: MESSAGES.signed_out });
  a.as(owner(OWNER_A));
  a.eligible({ eligible: false, reasons: ['domain_not_live'] });
  assert.match((await changeVoiceOp(a.deps, { packId: a.view.pack.id, voiceKey: 'oliver', version: '1' })).error ?? '', /not live yet/);
  assert.equal(a.calls.changeVoice.length, 0);
});

test('change voice: every refusal code from the generator reaches the screen as one plain sentence, never a code or a stack line', async () => {
  const a = await readyPack();
  const codes = [...VIDEO_ACTION_CODES, 'cost_cap', 'monthly_cap', 'spend_unknown'];
  for (const c of codes) assert.ok(PLAIN_CODES[c], `there is a sentence for ${c}`);
  const messages = [undefined, '', 'voice_limit_used', 'Error: boom at /var/task/x.js:12:3', 'x'];
  for (const code of codes) {
    for (const message of messages) {
      const deps = { ...a.deps, changeVoice: async () => ({ ok: false as const, code: code as never, message: message as never }) };
      const out = await changeVoiceOp(deps, { packId: a.view.pack.id, voiceKey: 'oliver', version: '1' });
      assert.ok(out.error && out.error.length > 8, `${code}/${String(message)}`);
      assert.doesNotMatch(out.error ?? '', /[a-z]+_[a-z]+|Error:|\bat \S+:\d+|undefined/, `${code}/${String(message)}: ${out.error}`);
    }
  }
  // The sentence for the code wins over the generator's own words (which can say "pack").
  const kept = await changeVoiceOp({ ...a.deps, changeVoice: async () => ({ ok: false as const, code: 'same_voice' as const, message: 'That is the voice your pack already has.' }) }, { packId: a.view.pack.id, voiceKey: 'oliver', version: '1' });
  assert.equal(kept.error, PLAIN_CODES.same_voice);
  // A code we do not know keeps a clean sentence, and drops one with an internal word in it.
  const unknown = (message: string) => changeVoiceOp({ ...a.deps, changeVoice: async () => ({ ok: false as const, code: 'brand_new' as never, message }) }, { packId: a.view.pack.id, voiceKey: 'oliver', version: '1' });
  assert.equal((await unknown('Please wait a moment and try again.')).error, 'Please wait a moment and try again.');
  assert.equal((await unknown('Your pack could not be changed.')).error, 'Something went wrong. Please try again.');
});

test('change voice: the same voice, a video still running and an approved pack are refused in plain words', async () => {
  const a = await readyPack();
  assert.match((await changeVoiceOp(a.deps, { packId: a.view.pack.id, voiceKey: 'jane', version: '1' })).error ?? '', /already has/);
  await a.h.setRender(OWNER_A, { state: 'running' });
  assert.match((await changeVoiceOp(a.deps, { packId: a.view.pack.id, voiceKey: 'oliver', version: '1' })).error ?? '', /being made right now/);
  await a.h.finishVideo(OWNER_A);
  assert.equal((await approveOp(a.deps, { packId: a.view.pack.id })).ok, true);
  assert.match((await changeVoiceOp(a.deps, { packId: a.view.pack.id, voiceKey: 'oliver', version: '1' })).error ?? '', /before you move on/);
  assert.equal((await a.h.store.getPack(OWNER_A))!.voiceChanges, 0);
});

test('change voice: a voice that was not available is changed for free and does not use the allowance', async () => {
  const a = await madePack();
  await a.h.setRender(OWNER_A, { state: 'failed', errorCode: 'voice_unavailable' });
  const view = (await a.h.engine.listPackForOwner(OWNER_A))!;
  assert.equal(view.voice.free, true);
  const out = await changeVoiceOp(a.deps, { packId: a.view.pack.id, voiceKey: 'olivia', version: '1' });
  assert.equal(out.ok, true);
  assert.match(out.notice ?? '', /This change was free/);
  assert.equal((await a.h.store.getPack(OWNER_A))!.voiceChanges, 0);
});

// ── Try again (38b) ──

test('retry: a failed video is queued again for the owner with the version pinned; a video that is fine, another owner’s pack and a missing version are refused', async () => {
  const a = await madePack();
  // Nothing to retry while it is only waiting.
  assert.match((await retryVideoOp(a.deps, { packId: a.view.pack.id, version: '1' })).error ?? '', /nothing to try again/i);
  await a.h.setRender(OWNER_A, { state: 'failed', errorCode: 'sandbox_failed' });
  a.as(owner(OWNER_B));
  assert.deepEqual(await retryVideoOp(a.deps, { packId: a.view.pack.id, version: '1' }), { error: MESSAGES.not_found });
  a.as(owner(OWNER_A));
  for (const version of [undefined, '', 'x']) assert.deepEqual(await retryVideoOp(a.deps, { packId: a.view.pack.id, version }), { error: MESSAGES.not_found });
  const before = a.calls.retry.length;
  const out = await retryVideoOp(a.deps, { packId: a.view.pack.id, version: '1' });
  assert.equal(out.ok, true);
  assert.deepEqual(a.calls.retry.slice(before), [{ ownerId: OWNER_A, expectedVersion: 1 }]);
  assert.equal((await a.h.engine.listPackForOwner(OWNER_A))!.video.status, 'queued');
  // A voice that is not available is not retried (the voice is changed instead).
  await a.h.setRender(OWNER_A, { state: 'failed', errorCode: 'voice_unavailable' });
  assert.match((await retryVideoOp(a.deps, { packId: a.view.pack.id, version: '1' })).error ?? '', /nothing to try again/i);
  // Plain words for a stale version and for a team member.
  assert.match((await retryVideoOp(a.deps, { packId: a.view.pack.id, version: '7' })).error ?? '', /moved on since you opened/);
  a.as({ ok: false, reason: 'member' });
  assert.deepEqual(await retryVideoOp(a.deps, { packId: a.view.pack.id, version: '1' }), { error: MESSAGES.member });
});

test('retry: an account that is not eligible is refused and a refusal code is always one plain sentence', async () => {
  const a = await madePack();
  a.eligible({ eligible: false, reasons: ['switch_off'] });
  assert.ok((await retryVideoOp(a.deps, { packId: a.view.pack.id, version: '1' })).error);
  assert.equal(a.calls.retry.length, 0);
  a.eligible(ELIGIBLE);
  for (const code of [...VIDEO_ACTION_CODES, 'cost_cap', 'monthly_cap', 'spend_unknown']) {
    const out = await retryVideoOp({ ...a.deps, retryVideo: async () => ({ ok: false as const, code: code as never, message: 'store_failed' as never }) }, { packId: a.view.pack.id, version: '1' });
    assert.doesNotMatch(out.error ?? '', /[a-z]+_[a-z]+/, code);
    assert.ok((out.error ?? '').length > 8);
  }
});

// ── Poll (38b) ──

test('poll: answers for the owner’s own pack with the video, approve and voice fields only, and nothing else', async () => {
  const a = await madePack();
  const out = await pollPackOp(a.deps, { packId: a.view.pack.id });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(Object.keys(out).sort(), ['approval', 'ok', 'version', 'video', 'voice']);
  assert.equal(out.version, 1);
  assert.equal(out.video.state, 'queued');
  assert.equal(out.video.poll, true);
  assert.equal(out.approval.ok, false);
  assert.match(out.approval.ok ? '' : out.approval.message, /as soon as your video is ready/);
  // Nothing internal: no id, no path, no owner, no raw code or error.
  const text = JSON.stringify(out);
  for (const secret of [OWNER_A, a.view.pack.id, a.view.ads[0].id, 'errorCode', 'sandbox', 'bucket', 'path']) assert.ok(!text.includes(secret), secret);
  assert.doesNotMatch(text, /[a-z]+_[a-z]+/, 'no snake_case code in what the browser gets');
});

test('poll: it follows the render to ready, to failed and to a voice that is not available, and stops asking when it has settled', async () => {
  const a = await madePack();
  const get = async () => {
    const o = await pollPackOp(a.deps, { packId: a.view.pack.id });
    assert.ok(o.ok);
    return o as Extract<typeof o, { ok: true }>;
  };
  await a.h.setRender(OWNER_A, { state: 'running' });
  assert.equal((await get()).video.state, 'making');
  assert.equal((await get()).video.poll, true);
  await a.h.finishVideo(OWNER_A);
  const ready = await get();
  assert.equal(ready.video.state, 'ready');
  assert.equal(ready.video.poll, false);
  assert.deepEqual(ready.approval, { ok: true });
  await a.h.setRender(OWNER_A, { state: 'failed', errorCode: 'voice_unavailable' });
  const unavailable = await get();
  assert.equal(unavailable.video.action, 'change_voice');
  assert.equal(unavailable.video.message, VOICE_UNAVAILABLE_TEXT);
  assert.equal(unavailable.video.poll, false);
});

test('poll: another owner’s pack, a made-up or missing pack id, a team member and a signed-out visitor get nothing', async () => {
  const a = await madePack();
  a.as(owner(OWNER_B));
  assert.deepEqual(await pollPackOp(a.deps, { packId: a.view.pack.id }), { ok: false });
  a.as(owner(OWNER_A));
  for (const packId of [undefined, '', 5, '00000000-0000-4000-8000-000000000000']) assert.deepEqual(await pollPackOp(a.deps, { packId }), { ok: false });
  a.as({ ok: false, reason: 'member' });
  assert.deepEqual(await pollPackOp(a.deps, { packId: a.view.pack.id }), { ok: false });
  a.as({ ok: false, reason: 'signed_out' });
  assert.deepEqual(await pollPackOp(a.deps, { packId: a.view.pack.id }), { ok: false });
});

// ── The player's link (38b) ──

test('video link: a fresh view link for a file of the owner’s own ready video; not for another owner, an image, a video not ready, or a path outside the owner’s folder', async () => {
  const a = await readyPack();
  const ad = a.view.ads.find((x) => x.angle === '5b')!;
  const out = await videoUrlOp(a.deps, { adId: ad.id, fileName: 'notice-4x5.mp4' });
  assert.equal(out.ok, true);
  assert.ok(out.ok && out.url.startsWith(`https://preview.example.test/${OWNER_A}/`));
  assert.equal((await videoUrlOp(a.deps, { adId: ad.id, fileName: 'notice-poster.png' })).ok, true);
  // Only the three videos and the poster; never an image, the voice file or a made-up name.
  const image = a.view.ads.find((x) => x.angle === '3a')!;
  for (const bad of [{ adId: ad.id, fileName: 'voice.mp3' }, { adId: ad.id, fileName: 'script.json' }, { adId: ad.id, fileName: '../x.mp4' }, { adId: ad.id, fileName: 'toString' }, { adId: image.id, fileName: image.files.images[0].name }, { adId: image.id, fileName: 'notice-9x16.mp4' }, { adId: '', fileName: 'notice-9x16.mp4' }, { adId: ad.id }, {}]) {
    assert.equal((await videoUrlOp(a.deps, bad)).ok, false);
  }
  a.as(owner(OWNER_B));
  assert.deepEqual(await videoUrlOp(a.deps, { adId: ad.id, fileName: 'notice-9x16.mp4' }), { ok: false, error: MESSAGES.download });
  a.as({ ok: false, reason: 'signed_out' });
  assert.deepEqual(await videoUrlOp(a.deps, { adId: ad.id, fileName: 'notice-9x16.mp4' }), { ok: false, error: MESSAGES.signed_out });
  // A video that is not ready has no link.
  const b = await madePack();
  const pending = b.view.ads.find((x) => x.angle === '5b')!;
  assert.equal((await videoUrlOp(b.deps, { adId: pending.id, fileName: 'notice-9x16.mp4' })).ok, false);
});

test('approve: while the video is being made or has failed the pack is not approved and the reason is plain', async () => {
  const a = await madePack();
  const pending = await approveOp(a.deps, { packId: a.view.pack.id, version: '1' });
  assert.match(pending.error ?? "", /as soon as it is ready/);
  await a.h.setRender(OWNER_A, { state: 'failed', errorCode: 'sandbox_failed' });
  assert.match((await approveOp(a.deps, { packId: a.view.pack.id, version: '1' })).error ?? '', /not ready yet/);
  assert.equal(a.records.length, 0);
  assert.equal((await a.h.store.getPack(OWNER_A))!.status, 'preview');
});

// ── Batch 55 (Part A, A7): the lead database route ──

// Built from parts: the app's own host is the domain on this route.
const APP_HOST = 'stay' + 'ful.co.uk';
const LEADDB: EligibilityFacts = { eligible: true, reasons: [], route: 'leaddb', website: { id: 'calc-site-1', settings: SETTINGS }, domain: APP_HOST, sitePath: 'brightstone-calc' };

test('generate, lead database route: the calculator site and this app’s host make the links, the pack is made on that route', async () => {
  const s = setup();
  s.eligible(LEADDB);
  assert.deepEqual(await generateOp(s.deps, input), { ok: true });
  assert.equal(s.calls.generated[0].input.route, 'leaddb');
  assert.equal(s.calls.generated[0].input.sitePath, 'brightstone-calc');
  assert.equal(s.calls.generated[0].input.domain, APP_HOST);
  const pack = await s.h.store.getPack(OWNER_A);
  assert.equal(pack?.route, 'leaddb');
  assert.equal(pack?.websiteId, 'calc-site-1');
  const ads = await s.h.store.listAds(OWNER_A, pack!.id);
  assert.equal(ads.length, 3);
  assert.ok(ads.every((a) => a.link.startsWith(`https://${APP_HOST}/s/brightstone-calc?ad=`)), 'the Stayful host and /s/<slug>');
});

test('generate, lead database route: the form cannot bring its own route, slug or host', async () => {
  const s = setup();
  s.eligible(LEADDB);
  assert.deepEqual(await generateOp(s.deps, { ...input, route: 'academy', sitePath: 'someone-else', domain: 'evil.co.uk' } as typeof input), { ok: true });
  assert.equal(s.calls.generated[0].input.route, 'leaddb');
  assert.equal(s.calls.generated[0].input.sitePath, 'brightstone-calc');
  assert.equal(s.calls.generated[0].input.domain, APP_HOST);
});

test('generate, lead database route: no slug, or not eligible, is refused in plain words and nothing is made', async () => {
  const s = setup();
  s.eligible({ ...LEADDB, sitePath: undefined });
  assert.deepEqual(await generateOp(s.deps, input), { error: MESSAGES.not_eligible });
  for (const [reason, pattern] of [
    ['no_leaddb_account', /not linked/],
    ['account_stopped', /not active/],
    ['no_card', /payment card/],
    ['not_allowed', /not open/],
    ['has_website', /own website/],
  ] as const) {
    s.eligible({ eligible: false, reasons: [reason], route: 'leaddb' });
    const out = await generateOp(s.deps, input);
    assert.match(out.error ?? '', pattern, reason);
    assert.doesNotMatch(out.error ?? '', /_/, reason);
  }
  assert.equal(s.calls.generate, 0);
  assert.equal(await s.h.store.getPack(OWNER_A), null);
});

test('generate, Academy route: no route or slug is sent, so the request is exactly what it was', async () => {
  const s = setup();
  assert.deepEqual(await generateOp(s.deps, input), { ok: true });
  assert.ok(!('route' in s.calls.generated[0].input));
  assert.ok(!('sitePath' in s.calls.generated[0].input));
  const pack = await s.h.store.getPack(OWNER_A);
  assert.equal(pack?.route, 'academy');
  assert.ok((await s.h.store.listAds(OWNER_A, pack!.id)).every((a) => a.link.startsWith('https://brightstone.co.uk/?ad=')));
});
