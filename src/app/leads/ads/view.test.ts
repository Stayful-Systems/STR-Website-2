import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ELIGIBILITY_REASONS, plainReason } from '../../../lib/ad-packs/eligibility.ts';
import { CHECK_IDS } from '../../../lib/ad-packs/checks.ts';
import { PACK_STATUSES } from '../../../lib/ad-packs/store-types.ts';
import { harness } from '../../../lib/ad-packs/test-store.ts';
import type { GenerateOk } from '../../../lib/ad-packs/generate-core.ts';
import {
  adCopyItems,
  adViewModel,
  areaPreviewView,
  brandOfSettings,
  brandProblemText,
  checksFailedView,
  CHECK_PLAIN_IDS,
  copyTargetExists,
  eligibilityView,
  entryCardView,
  figureCallout,
  groupCardFiles,
  lengthView,
  approvalVm,
  isVideoFileName,
  pollStep,
  pollViewOf,
  POLL_GIVE_UP_MS,
  POLL_INTERVAL_MS,
  VIDEO_ACTION_TEXT,
  VIDEO_FILE_LABELS,
  videoActionMessage,
  videoCardView,
  videoFilesOf,
  videoViewOfSlot,
  videoVm,
  voiceCards,
  voiceVm,
  VOICE_STEP_HELP,
} from './view.ts';
import { VOICES } from '../../../lib/ad-packs/voices.ts';
import { VIDEO_ACTION_CODES, VIDEO_MESSAGES, type PackView } from '../../../lib/ad-packs/generate-core.ts';
import { readyVideo } from '../../../lib/ad-packs/test-store.ts';

const OWNER = '3f9a2c11-1111-4111-8111-111111111111';

// Anything that looks like an internal code: snake_case, a dotted id, or a SCREAMING word.
const LOOKS_LIKE_A_CODE = /[a-z]+_[a-z]+|\b[A-Z]{2,}_[A-Z_]+\b|\b[a-z]+\.[a-z]+\.[a-z]+\b/;

// ── Eligibility ──

test('every reason becomes a plain sentence and a next step; no internal code leaks', () => {
  for (const r of ELIGIBILITY_REASONS) {
    const v = eligibilityView([r]);
    assert.equal(v.sentences.length, 1, r);
    assert.equal(v.sentences[0], plainReason(r));
    assert.ok(v.sentences[0].length > 20 && /[.]$/.test(v.sentences[0]), r);
    assert.ok(v.next.length >= 1, `${r} has a next step`);
    const everything = [v.title, ...v.sentences, ...v.next.flatMap((n) => [n.text, n.label ?? ''])].join(' ');
    assert.ok(!everything.includes(r), `${r} is not shown`);
    assert.doesNotMatch(everything, LOOKS_LIKE_A_CODE, r);
  }
});

test('several reasons: each is a sentence, the title is calm, repeated next steps are said once, links stay inside the app', () => {
  const v = eligibilityView(['site_not_live', 'no_domain', 'switch_off', 'no_domain']);
  assert.equal(v.title, 'Your ad pack is not ready yet');
  assert.equal(v.sentences.length, 3);
  assert.equal(new Set(v.next.map((n) => n.text)).size, v.next.length);
  for (const n of v.next) if (n.href) assert.match(n.href, /^\/leads\//);
  assert.equal(eligibilityView(['not_owner']).title, 'Only the account owner can set up the ad pack');
  assert.deepEqual(eligibilityView([]).sentences, []);
});

// ── Length indicator ──

test('headline: green up to Meta’s 27, amber to the pack’s 40, red beyond; both limits are said', () => {
  const g = lengthView('headline', 'x'.repeat(27));
  assert.equal(g.level, 'green');
  assert.equal(g.counter, '27 characters');
  assert.match(g.limits, /Meta recommends 27/);
  assert.match(g.limits, /allows up to 40/);
  assert.match(g.badge, /success/);
  const a = lengthView('headline', 'x'.repeat(28));
  assert.equal(a.level, 'amber');
  assert.match(a.badge, /warning/);
  assert.equal(lengthView('headline', 'x'.repeat(40)).level, 'amber');
  const r = lengthView('headline', 'x'.repeat(41));
  assert.equal(r.level, 'red');
  assert.match(r.badge, /destructive/);
  assert.equal(lengthView('headline', 'x').counter, '1 character');
  assert.notEqual(g.word, a.word);
  assert.notEqual(a.word, r.word);
});

test('primary text: judged on the first sentence and the whole, with Meta’s 125 and the pack’s 300', () => {
  const short = lengthView('primary', 'Short and sweet. And a second sentence follows it.');
  assert.equal(short.level, 'green');
  assert.match(short.limits, /125/);
  assert.match(short.limits, /300/);
  assert.equal(lengthView('primary', `${'word '.repeat(30)}end.`).level, 'amber', 'a first sentence over 125');
  assert.equal(lengthView('primary', `Fine. ${'x'.repeat(300)}`).level, 'red');
  assert.equal(lengthView('primary', '').level, 'red');
});

test('description: the cut-off-past-30 note is always shown; green to 90, red beyond', () => {
  const short = lengthView('description', 'A short one.');
  assert.match(short.limits, /may cut it off on some placements past 30 characters/i);
  assert.match(short.limits, /up to 90/);
  const mid = lengthView('description', 'x'.repeat(31));
  assert.equal(mid.level, 'green');
  assert.equal(mid.notes.filter((n) => /cut off/i.test(n)).length, 0, 'the note is said once, in the limits line');
  assert.equal(lengthView('description', 'x'.repeat(90)).level, 'green');
  assert.equal(lengthView('description', 'x'.repeat(91)).level, 'red');
});

// ── Copy items ──

test('copy items carry each text exactly as stored: no trimming, no changes', () => {
  const ad = {
    adName: 'SI-3F9A2C-5B-1 · Tenant notice',
    link: 'https://brightstone.co.uk/?ad=SI-3F9A2C-5B-1&utm_source=facebook&utm_medium=paid_social&utm_campaign=SI-3F9A2C&utm_content={{ad.id}}',
    texts: { primary: ['  Has two leading spaces and a line\nbreak.  '], headlines: ['One', 'Two', 'Three'], descriptions: ['A description.'] },
  };
  const c = adCopyItems(ad);
  assert.equal(c.name.text, ad.adName);
  assert.equal(c.link.text, ad.link, '{{ad.id}} is copied untouched');
  assert.equal(c.primary[0].text, ad.texts.primary[0]);
  assert.deepEqual(c.headlines.map((h) => h.text), ad.texts.headlines);
  assert.deepEqual(c.headlines.map((h) => h.label), ['Headline 1', 'Headline 2', 'Headline 3']);
  assert.equal(c.primary[0].label, 'Primary text');
  assert.equal(c.name.length, null);
  assert.equal(c.link.length, null);
  assert.ok(c.primary[0].length && c.headlines.every((h) => h.length) && c.descriptions[0].length);
  assert.deepEqual([c.name, c.link, ...c.primary, ...c.headlines, ...c.descriptions].map((i) => i.kind), ['name', 'link', 'primary', 'headline', 'headline', 'headline', 'description']);
});

test('copyTargetExists: only a text the ad really has', () => {
  const ad = { texts: { primary: ['a'], headlines: ['a', 'b'], descriptions: [] } };
  assert.equal(copyTargetExists(ad, 'headline', 1), true);
  assert.equal(copyTargetExists(ad, 'headline', 2), false);
  assert.equal(copyTargetExists(ad, 'description', 0), false);
  assert.equal(copyTargetExists(ad, 'name', 0), true);
  assert.equal(copyTargetExists(ad, 'link', 1), false);
  assert.equal(copyTargetExists(ad, 'primary', -1), false);
  assert.equal(copyTargetExists(ad, 'primary', 0.5), false);
});

// ── Files ──

test('files are grouped by card with plain size words; the preview is the 4:5 file', () => {
  const names = ['3a-card2-9x16.png', '3a-card1-1x1.png', '3a-card1-4x5.png', '3a-card1-9x16.png', '3a-card2-4x5.png', 'junk.txt'].map((name) => ({ name, width: 1080, height: 1080 }));
  const g = groupCardFiles(names);
  assert.deepEqual(g.map((c) => c.card), [1, 2]);
  assert.equal(g[0].previewName, '3a-card1-4x5.png');
  assert.deepEqual(g[0].files.map((f) => f.size), ['Square 1:1', 'Portrait 4:5', 'Stories 9:16']);
  assert.equal(g[1].files.length, 2);
  assert.deepEqual(groupCardFiles([]), []);
  assert.equal(groupCardFiles([{ name: '3a-card3-9x16.png', width: 1, height: 1 }])[0].previewName, '3a-card3-9x16.png');
});


test('a generated pack becomes three ad view models: 5b with its video slot and no cards, the others with five cards of three files', async () => {
  const h = harness();
  const made = (await h.engine.generatePack({
    ownerId: OWNER,
    by: 'operator',
    input: { areaKey: 'NG7', photos: [], brand: { company: 'Brightstone Stays', logoUrl: 'https://cdn.example.test/logo.png', brandColour: '#1F6F5C', feePct: 12, photoUrl: null }, domain: 'brightstone.co.uk' },
  })) as GenerateOk;
  const view = (await h.engine.listPackForOwner(OWNER))!;
  assert.equal(made.status, 'preview');
  const vms = view.ads.map((a) => adViewModel(a, (path) => `https://signed.example.test/${path}`));
  assert.deepEqual(vms.map((v) => v.angle), ['5b', '3a', '17']);
  const b = vms[0];
  assert.equal(b.video?.card.state, 'queued');
  assert.equal(b.video?.card.poll, true);
  assert.equal(b.cards.length, 0);
  for (const v of vms.slice(1)) {
    assert.equal(v.video, null);
    assert.equal(v.cards.length, 5);
    assert.ok(v.cards.every((c) => c.files.length === 3 && c.previewUrl?.includes('-4x5.png')));
  }
  assert.deepEqual(vms.map((v) => v.title), ['Tenant notice', 'Moving abroad', 'Renting rules changed']);
  assert.ok(vms.every((v) => v.copy.primary.length > 0 && v.copy.headlines.length > 0 && v.copy.descriptions.length > 0 && v.adName.includes(v.code)));
  // The labelled example figure is available to show.
  const fig = figureCallout(view.pack.figures);
  assert.ok(fig);
  assert.match(fig!.label, /^Example: a typical 3-bed in /);
});

// ── Checks failed ──

test('every check has a plain sentence of its own, and a failed pack never shows a code', () => {
  assert.deepEqual([...CHECK_PLAIN_IDS].sort(), [...CHECK_IDS].sort());
  const v = checksFailedView({ failures: CHECK_IDS.map((check) => ({ check, rule: 'brand_logo', where: 'pack', detail: 'It mentions Someone Else.' })) });
  assert.equal(v.title, "We couldn't build your pack yet");
  assert.equal(v.lines.length, CHECK_IDS.length);
  const everything = [v.title, ...v.lines, v.contact].join(' ');
  for (const id of CHECK_IDS) if (id.includes('_')) assert.ok(!everything.includes(id), id);
  assert.doesNotMatch(everything, LOOKS_LIKE_A_CODE);
  assert.doesNotMatch(everything, /Someone Else|brand_logo/, 'the detail of a failure is not shown');
  assert.match(v.contact, /contact support/i);
  // Repeated failures of one check say it once; none at all still says something.
  assert.equal(checksFailedView({ failures: [{ check: 'length' }, { check: 'length' }] }).lines.length, 1);
  assert.equal(checksFailedView(null).lines.length, 1);
  assert.equal(checksFailedView({ failures: [{ check: 'not_a_check' }] }).lines.length, 1);
});

// ── The area and the brand ──

test('area preview: the bedroom size we will use is read-only and explained; a fall-back and a thin area are said plainly', () => {
  const ok = areaPreviewView({ areaKey: 'NG7', areaLabel: 'Lenton, Nottingham', fellBack: false, bedrooms: 3, samples: 14 });
  assert.equal(ok.ok, true);
  assert.equal(ok.bedrooms, 3);
  assert.match(ok.text, /typical 3-bed/);
  assert.match(ok.text, /most common size in Lenton, Nottingham, from 14 reports/);
  assert.match(ok.text, /we pick it for you/);
  assert.match(areaPreviewView({ areaKey: 'NG', areaLabel: 'Nottingham', fellBack: true, bedrooms: 2, samples: 1 }).text, /too few reports.*wider area, Nottingham.*1 report\./);
  const thin = areaPreviewView({ error: 'not_enough_data' });
  assert.equal(thin.ok, false);
  assert.equal(thin.bedrooms, null);
  assert.doesNotMatch(thin.text, /not_enough_data/);
});

test('brand: read from the website’s settings; a logo that is not https is no logo; company and colour are the only blockers', () => {
  const base = { companyName: ' Brightstone Stays ', logoUrl: 'https://cdn.example.test/l.png', brandColour: '#1F6F5C', managementFeePct: 12, areas: [' Nottingham ', ''], photoUrl: ' ' };
  const ok = brandOfSettings(base);
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.brand, { company: 'Brightstone Stays', logoUrl: 'https://cdn.example.test/l.png', brandColour: '#1f6f5c', feePct: 12, areas: ['Nottingham'], photoUrl: null });
  assert.equal(brandOfSettings({ ...base, logoUrl: 'http://cdn.example.test/l.png' }).brand.logoUrl, null);
  assert.equal(brandOfSettings({ ...base, logoUrl: null }).problems.length, 0, 'a missing logo is the operator’s choice (type only)');
  assert.deepEqual(brandOfSettings({ ...base, companyName: '' }).problems, ['company']);
  assert.deepEqual(brandOfSettings({ ...base, brandColour: 'blue' }).problems, ['colour']);
  assert.equal(brandOfSettings({ ...base, managementFeePct: null }).brand.feePct, null);
  for (const p of ['company', 'colour'] as const) assert.doesNotMatch(brandProblemText(p), LOOKS_LIKE_A_CODE);
});

test('the figure callout reads only the two sentences; nothing, or nothing labelled, is null', () => {
  assert.deepEqual(figureCallout([{ label: 'Example: a typical 3-bed in X, from 14 reports. Every property is different.', sentence: 'Example: … about £2,350 a month.', amount: 2350 }]), { label: 'Example: a typical 3-bed in X, from 14 reports. Every property is different.', sentence: 'Example: … about £2,350 a month.' });
  assert.equal(figureCallout([]), null);
  assert.equal(figureCallout(null), null);
  assert.equal(figureCallout([{ sentence: 'no label' }]), null);
  assert.equal(figureCallout(['x']), null);
});

// ── The entry card ──

test('the entry card says something plain for every pack status, with no code', () => {
  for (const status of [null, ...PACK_STATUSES]) {
    const v = entryCardView(status);
    assert.ok(v.title && v.body && v.cta, String(status));
    assert.doesNotMatch(`${v.title} ${v.body} ${v.cta}`, LOOKS_LIKE_A_CODE, String(status));
  }
  assert.equal(entryCardView(null).cta, 'Make my ads');
  assert.equal(entryCardView('preview').cta, 'Look at my ads');
  assert.equal(entryCardView('approved').title, 'Your ads are ready to use');
});


// ── The voice step and the video (38b) ──

test('the voice step: three cards from the voice list, each with its free sample clip, and the plain instruction', () => {
  const cards = voiceCards();
  assert.deepEqual(cards.map((c) => c.key), ['jane', 'olivia', 'oliver']);
  for (const c of cards) {
    assert.ok(c.label && c.description.length > 10);
    assert.match(c.previewUrl, /^https:\/\//, 'the sample plays from a secure address');
    assert.equal(c.previewUrl, VOICES.find((v) => v.key === c.key)!.previewUrl);
  }
  assert.equal(VOICE_STEP_HELP, 'Pick the voice for your video. Press play to hear it first.');
});

const pending = { status: 'queued', code: null, poll: true, canRetry: false, message: null } as const;

test('the video card: making, ready, and each failure has one plain sentence and the right action', () => {
  const making = videoCardView(pending);
  assert.equal(making.poll, true);
  assert.equal(making.action, 'none');
  assert.match(making.message ?? '', /^Making your video… this usually takes 3 to 6 minutes\. You can leave this page and come back\.$/);
  assert.equal(videoCardView({ ...pending, status: 'making' }).state, 'making');

  const ready = videoCardView({ status: 'ready', code: null, poll: false, canRetry: false, message: null });
  assert.deepEqual([ready.poll, ready.message, ready.action], [false, null, 'none']);

  const voice = videoCardView({ status: 'failed', code: 'voice_unavailable', poll: false, canRetry: false, message: VIDEO_MESSAGES.voice_unavailable });
  assert.equal(voice.action, 'change_voice');
  assert.equal(voice.message, "That voice isn't available yet. Please choose another.");

  const retry = videoCardView({ status: 'failed', code: 'sandbox_failed', poll: false, canRetry: true, message: VIDEO_MESSAGES.video_failed });
  assert.equal(retry.action, 'retry');
  assert.match(retry.message ?? '', /Try again/);

  const stuck = videoCardView({ status: 'failed', code: 'bad_brief', poll: false, canRetry: false, message: VIDEO_MESSAGES.video_failed });
  assert.equal(stuck.action, 'contact');
  assert.doesNotMatch(stuck.message ?? '', /Try again/, 'there is no button to press');

  assert.equal(videoCardView({ status: 'coming', code: null, poll: false, canRetry: false, message: null }).action, 'contact');
  // Whatever the code, nothing internal is shown and nothing says "coming soon" or "later release".
  for (const code of ['sandbox_failed', 'monthly_cap', 'voice_quota', 'timeout', 'voice_unavailable', null]) {
    for (const canRetry of [true, false]) {
      const v = videoCardView({ status: 'failed', code, poll: false, canRetry, message: null });
      const everything = `${v.heading} ${v.message}`;
      assert.doesNotMatch(everything, LOOKS_LIKE_A_CODE, `${code}: ${everything}`);
      assert.doesNotMatch(everything, /coming soon|later release|arrives/i);
    }
  }
});

test('the video slot of an ad stands in for the live state when there is none', () => {
  assert.equal(videoViewOfSlot(null).status, 'coming');
  assert.equal(videoViewOfSlot({ status: 'coming' }).status, 'coming');
  assert.deepEqual(videoViewOfSlot({ status: 'queued' }), { status: 'queued', code: null, poll: true, canRetry: false, message: null });
  assert.equal(videoViewOfSlot({ status: 'making' }).poll, true);
  assert.equal(videoViewOfSlot({ status: 'failed', code: 'voice_unavailable' }).code, 'voice_unavailable');
  assert.equal(videoViewOfSlot(readyVideo(OWNER, 'p', 1)).poll, false);
});

test('the video files: three sizes in order with their plain labels, the poster, and only for a ready video', () => {
  const ready = readyVideo(OWNER, 'pack-1', 1);
  const shuffled = { ...ready, videos: [...ready.videos].reverse() };
  const out = videoFilesOf(shuffled);
  assert.deepEqual(out.files.map((f) => f.label), ['Stories and Reels (9:16)', 'Feed (4:5)', 'Square (1:1)']);
  assert.deepEqual(out.files.map((f) => f.ratio), ['9:16', '4:5', '1:1']);
  assert.equal(out.poster, 'notice-poster.png');
  assert.equal(out.seconds, 38);
  assert.deepEqual(videoFilesOf({ status: 'queued' }), { files: [], poster: null, seconds: null });
  assert.deepEqual(videoFilesOf(null), { files: [], poster: null, seconds: null });
  // A name that is not one of the three is not offered; inherited object keys are not names.
  const odd = videoFilesOf({ ...ready, videos: [...ready.videos, { ...ready.videos[0], name: 'voice.mp3' }, { ...ready.videos[0], name: 'toString' }] });
  assert.equal(odd.files.length, 3);
  assert.ok(isVideoFileName('notice-1x1.mp4') && !isVideoFileName('toString') && !isVideoFileName('notice-poster.png') && !isVideoFileName(3));
  assert.deepEqual(Object.keys(VIDEO_FILE_LABELS), ['notice-9x16.mp4', 'notice-4x5.mp4', 'notice-1x1.mp4']);
});

test('videoVm: view links only for a ready video, by file name', () => {
  const ready = readyVideo(OWNER, 'pack-1', 1);
  const vm = videoVm(ready, videoViewOfSlot(ready), (p) => `https://signed.example.test/${p}`);
  assert.equal(vm.card.state, 'ready');
  assert.deepEqual(Object.keys(vm.urls).sort(), ['notice-1x1.mp4', 'notice-4x5.mp4', 'notice-9x16.mp4', 'notice-poster.png']);
  assert.equal(vm.urls['notice-9x16.mp4'], `https://signed.example.test/${OWNER}/pack-1/v1/notice-9x16.mp4`);
  const waiting = videoVm({ status: 'queued' }, videoViewOfSlot({ status: 'queued' }), () => 'https://x.example.test/');
  assert.deepEqual([waiting.files, waiting.urls], [[], {}]);
  // A signer that cannot sign leaves the link out.
  assert.deepEqual(videoVm(ready, videoViewOfSlot(ready), () => null).urls, {});
});

test('every refusal code of the video actions has a plain sentence, and a sentence from the generator wins over a code', () => {
  const codes = [...VIDEO_ACTION_CODES, 'cost_cap', 'monthly_cap', 'spend_unknown'];
  assert.deepEqual(Object.keys(VIDEO_ACTION_TEXT).sort(), [...codes].sort());
  for (const [code, text] of Object.entries(VIDEO_ACTION_TEXT)) {
    assert.ok(/[.]$/.test(text) && text.length > 20, code);
    assert.doesNotMatch(text, LOOKS_LIKE_A_CODE, code);
  }
  // Where the generator has its own wording, the screen says the same thing.
  for (const key of ['after_approval', 'same_voice', 'voice_limit_used', 'video_running', 'not_retryable'] as const) assert.equal(VIDEO_ACTION_TEXT[key], VIDEO_MESSAGES[key]);
  assert.equal(videoActionMessage('same_voice', 'A short but real sentence.'), 'A short but real sentence.');
  assert.equal(videoActionMessage('same_voice', 'same_voice'), VIDEO_ACTION_TEXT.same_voice);
  assert.equal(videoActionMessage('nope', undefined), 'Something went wrong. Please try again.');
  assert.equal(videoActionMessage(undefined, 'Error: x at /var/task/a.js:1:2 and more words'), 'Something went wrong. Please try again.');
});

/** A PackView with only the parts the video screen reads. */
function packView(over: { video: PackView['video']; approval?: PackView['approval']; voice?: Partial<PackView['voice']> }): PackView {
  return {
    pack: { version: 3 } as PackView['pack'],
    ads: [],
    showAds: true,
    olderCodes: [],
    freeRegensLeft: 1,
    render: null,
    video: over.video,
    voice: { key: 'jane', changesLeft: 1, canChange: true, free: false, blocked: null, ...over.voice },
    approval: over.approval ?? { ok: true },
  };
}

test('approve is off, with a plain reason, while the video is being made, failed or missing, and on when it is ready', () => {
  const v = (status: PackView['video']['status'], code: string | null = null, canRetry = false): PackView['video'] => ({ status, code, message: null, poll: status === 'queued' || status === 'making', canRetry });
  assert.deepEqual(approvalVm(packView({ video: v('ready') })), { ok: true });
  const waiting = approvalVm(packView({ video: v('making'), approval: { ok: false, code: 'video_pending', message: VIDEO_MESSAGES.video_pending } }));
  assert.deepEqual(waiting, { ok: false, message: 'Your video is still being made. It usually takes a few minutes.' });
  const failed = approvalVm(packView({ video: v('failed', 'bad_brief'), approval: { ok: false, code: 'video_failed', message: VIDEO_MESSAGES.video_failed } }));
  assert.equal(failed.ok, false);
  assert.doesNotMatch(failed.ok ? '' : failed.message, /Try again/, 'there is no retry button for this one');
  const missing = approvalVm(packView({ video: v('coming'), approval: { ok: false, code: 'video_pending', message: VIDEO_MESSAGES.video_pending } }));
  assert.match(missing.ok ? '' : missing.message, /no video with this pack/);
  const checks = approvalVm(packView({ video: v('ready'), approval: { ok: false, code: 'not_preview', message: 'Only a pack that is ready to look at can be approved.' } }));
  assert.deepEqual(checks, { ok: false, message: 'Only a pack that is ready to look at can be approved.' });
});

test('the voice step says how many changes are left, and that a free change is free', () => {
  const base = { key: 'jane', changesLeft: 1, canChange: true, free: false, blocked: null } as const;
  assert.equal(voiceVm(base).note, 'You can change the voice once before you approve.');
  assert.equal(voiceVm({ ...base, changesLeft: 3 }).note, 'You can change the voice 3 times before you approve.');
  assert.equal(voiceVm({ ...base, changesLeft: 0, canChange: false, blocked: { code: 'voice_limit_used', message: VIDEO_MESSAGES.voice_limit_used } }).note, 'You have used your voice change.');
  assert.equal(voiceVm({ ...base, changesLeft: 0, free: true }).note, 'The first voice could not be used, so this change is free.');
  const blocked = voiceVm({ ...base, canChange: false, blocked: { code: 'video_running', message: VIDEO_MESSAGES.video_running } });
  assert.equal(blocked.blocked, VIDEO_MESSAGES.video_running);
  assert.equal(voiceVm(base).currentLabel, 'Jane');
  assert.equal(voiceVm({ ...base, key: null }).currentLabel, null);
});

test('polling stops when the video settles or the pack moves on, waits otherwise, and gives up after fifteen minutes', () => {
  assert.equal(POLL_INTERVAL_MS, 8000);
  assert.equal(POLL_GIVE_UP_MS, 15 * 60 * 1000);
  assert.equal(pollStep({ startedMs: 0, nowMs: 8000, poll: true }), 'wait');
  assert.equal(pollStep({ startedMs: 0, nowMs: 8000, poll: false }), 'settled');
  assert.equal(pollStep({ startedMs: 0, nowMs: 8000, poll: true, versionChanged: true }), 'settled');
  assert.equal(pollStep({ startedMs: 0, nowMs: POLL_GIVE_UP_MS - 1, poll: true }), 'wait');
  assert.equal(pollStep({ startedMs: 0, nowMs: POLL_GIVE_UP_MS, poll: true }), 'give_up');
  // A video that settled at the very end is a reload, not "taking longer".
  assert.equal(pollStep({ startedMs: 0, nowMs: POLL_GIVE_UP_MS + 5000, poll: false }), 'settled');
});

test('a poll answer holds the version, the video card, the approve state and the voice step, and no ids, paths or codes', () => {
  const view = packView({ video: { status: 'failed', code: 'sandbox_failed', message: VIDEO_MESSAGES.video_failed, poll: false, canRetry: true }, approval: { ok: false, code: 'video_failed', message: VIDEO_MESSAGES.video_failed } });
  const out = pollViewOf(view);
  assert.deepEqual(Object.keys(out).sort(), ['approval', 'version', 'video', 'voice']);
  assert.equal(out.version, 3);
  assert.equal(out.video.action, 'retry');
  assert.doesNotMatch(JSON.stringify(out), /sandbox_failed|video_failed|[a-z]+_[a-z]+/);
});
