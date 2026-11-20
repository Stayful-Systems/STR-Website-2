import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Batch 38 phase 8: the screen's wiring, in the repo's source-pin style (the
 * page, the client component and the server actions need a session, a browser
 * and a database). The rules themselves are tested in ops.test.ts, view.test.ts
 * and state.test.ts.
 */
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const actions = code(read('./actions.ts'));
const client = code(read('./AdPackClient.tsx'));
const page = code(read('./page.tsx'));
const voiceCards = code(read('./VoiceCards.tsx'));
const videoSection = code(read('./VideoSection.tsx'));

test('actions.ts is a server-actions file that only exports async functions, each a thin wrapper over ops.ts', () => {
  assert.match(read('./actions.ts'), /^'use server';/);
  const exports = [...actions.matchAll(/^export (\w+)/gm)].map((m) => m[1]);
  assert.ok(exports.length >= 6);
  assert.ok(exports.every((e) => e === 'async'), `only async functions are exported, got ${exports.join(', ')}`);
  for (const op of ['generateOp', 'approveOp', 'downloadOp', 'copyOp', 'uploadPhotoOp', 'areaPreviewOp', 'changeVoiceOp', 'retryVideoOp', 'pollPackOp', 'videoUrlOp']) assert.match(actions, new RegExp(`${op}\\(liveDeps\\(\\)`), op);
  // The owner is the session's: no action reads an owner, user or brand from the form.
  assert.doesNotMatch(actions, /formData\.get\('(owner|user|member|brand|domain|company|website)/i);
  assert.match(actions, /ownerIdOrNull\(user\)/);
  assert.match(actions, /isAdminEmail\(user\.email\)/);
});

test('the copy log is handed the ad id, the kind and the position, never a text', () => {
  const fn = actions.slice(actions.indexOf('export async function recordCopyAction'));
  assert.match(fn, /recordCopyAction\(adId: string, kind: string, index: number\)/);
  assert.match(fn, /copyOp\(liveDeps\(\), \{ adId, kind, index \}\)/);
  assert.doesNotMatch(client, /recordCopyAction\([^)]*\.text/);
  assert.match(client, /recordCopyAction\(adId, item\.kind, item\.index\)/);
});

test('copy is instant: the clipboard first, the log after it and not waited for', () => {
  const fn = client.slice(client.indexOf('async function copy()'), client.indexOf('return (', client.indexOf('async function copy()')));
  assert.ok(fn.indexOf('navigator.clipboard.writeText(item.text)') >= 0);
  assert.ok(fn.indexOf('navigator.clipboard.writeText') < fn.indexOf('recordCopyAction'), 'clipboard before the log');
  assert.match(fn, /void recordCopyAction\(/);
  assert.doesNotMatch(fn, /await recordCopyAction/);
  assert.match(fn, /\.catch\(/);
  // The text is copied exactly as stored.
  assert.doesNotMatch(client, /item\.text\.trim\(\)|writeText\([^)]*trim/);
});

test('the page is the owner’s only, eligibility decides what it shows, and the admin preview passes admin through', () => {
  assert.match(page, /ownerIdOrNull\(user\)/);
  assert.match(page, /redirect\("\/leads"\)/);
  assert.match(page, /packEligibility\(user\.id, \{ admin \}\)/);
  assert.match(page, /isAdminEmail\(user\.email\)/);
  assert.match(page, /listPackForOwner\(ownerId\)/, 'the pack is read for the session’s owner id');
  assert.doesNotMatch(page, /searchParams|params\b/, 'nothing in the address chooses whose pack is shown');
  assert.match(page, /export const maxDuration = 60/);
});

test('the page leaves a place for the setup guide, and shows the video slot and the labelled figure', () => {
  assert.match(page, /id="guide"/);
  assert.match(page, /href="#guide"/);
  assert.match(page, /figureCallout\(pack\.figures\)/);
  assert.match(read('./AdSection.tsx'), /ad\.video \?/);
});

test('the form: the area pick list, photos up to four, a Generate button and the type-only tick only without a logo', () => {
  assert.match(client, /Confirm your main area/);
  assert.match(client, /MAX_PHOTOS = 4/);
  assert.match(client, /accept="image\/jpeg,image\/png"/);
  assert.match(client, /name="photoRef"/);
  assert.match(client, /name="typeOnly"/);
  assert.match(client, /!p\.hasLogo/);
  assert.match(client, /Make my ads/);
  assert.match(client, /Approve my ads/);
});

test('the entry card is for an account owner only, inside Suspense, with no new nav item', () => {
  const leads = code(read('../page.tsx'));
  assert.match(leads, /isOwner \? <Suspense fallback=\{null\}><AdPackEntryCard userId=\{user\.id\} \/><\/Suspense> : null/);
  assert.doesNotMatch(read('../LeadsNav.tsx'), /leads\/ads/);
  const entry = code(read('../../../lib/ad-packs/entry-server.ts'));
  assert.ok(entry.indexOf('readAdPacksEnabled()') < entry.indexOf('packEligibility('), 'the switch is read first: off means one tiny query');
  assert.match(entry, /catch \{\s*return false;/, 'it fails closed');
});

test('the generator reads an operator’s stored photos from the bucket, and the fonts are still traced for this page', () => {
  assert.match(code(read('../../../lib/ad-packs/generate-server.ts')), /fetchImage: adPackFetchImage/);
  assert.match(read('../../../../next.config.ts'), /"\/leads\/ads": \[\.\.\.AD_PACK_FONTS/);
});

test('the kinds the screen logs are registered', async () => {
  const { isActivityKind } = await import('../../../lib/activity/kinds.ts');
  assert.equal(isActivityKind('ad_pack_approved'), true);
  assert.equal(isActivityKind('ad_text_copied'), true);
  assert.match(actions, /liveDeps/);
});

// ── 38b: the voice step, the video and the poll ──

test('the voice step: three cards, a native audio player on the sample clip that loads only when asked, a radio choice posted as voiceKey', () => {
  assert.match(voiceCards, /<audio\s[\s\S]*controls[\s\S]*preload="none"[\s\S]*src=\{v\.previewUrl\}/);
  assert.match(voiceCards, /type="radio"/);
  assert.match(voiceCards, /role="radiogroup"/);
  assert.match(voiceCards, /voiceCards\(\)/);
  assert.doesNotMatch(voiceCards, /new Audio\(|<script|createElement\("script"\)/, 'no script, no third-party player');
  // Before the Generate button, in the start form only, default Jane, posted as voiceKey.
  assert.match(client, /useState<VoiceKey>\(DEFAULT_VOICE_KEY\)/);
  assert.match(client, /<VoiceCards name="voiceKey" value=\{voiceKey\}/);
  assert.ok(client.indexOf('<VoiceCards') < client.indexOf('<Button type="submit" size="lg" disabled={pending || blocked}'), 'the voice step comes before Generate');
  assert.match(client, /regenerate \? \(/, 'a regenerate keeps the voice and offers no voice step');
  assert.match(actions, /voiceKey: text\(formData\.get\('voiceKey'\)\)/);
});

test('the video section polls through a server action, reloads once, stops on leaving and gives up', () => {
  assert.match(videoSection, /^"use client";/);
  assert.match(videoSection, /pollPackAction\(packId\)/);
  assert.match(videoSection, /pollStep\(\{ startedMs, nowMs: Date\.now\(\), poll, versionChanged \}\)/);
  assert.match(videoSection, /router\.refresh\(\)/);
  assert.match(videoSection, /return \(\) => \{\s*stopped = true;\s*if \(timer\) clearTimeout\(timer\);/, 'stops on unmount');
  assert.match(videoSection, /VIDEO_SLOW_TEXT/);
  assert.match(videoSection, /POLL_INTERVAL_MS/);
  assert.match(videoSection, /Making your video… this usually takes 3 to 6 minutes\. You can leave this page and come back\./);
});

test('the player: a video element with controls, inline on a phone, metadata only, and a fresh link when the first one runs out', () => {
  assert.match(videoSection, /<video[\s\S]*controls[\s\S]*playsInline[\s\S]*preload="metadata"/);
  assert.match(videoSection, /poster=\{posterUrl\}/);
  assert.match(videoSection, /onError=\{\(\) => void refresh\(\)\}/);
  assert.match(videoSection, /videoUrlAction\(adId, file\.name\)/);
  assert.match(videoSection, /MAX_LINK_REFRESHES/);
  // Plain labels for the three sizes, and the three downloads once approved, through the owner-checked download action.
  assert.match(videoSection, /approved && card\.state === "ready"/);
  assert.match(videoSection, /<DownloadButton key=\{f\.name\} adId=\{adId\} fileName=\{f\.name\} label=\{f\.label\} \/>/);
});

test('failed videos offer the right button, a voice change is hidden once approved, and approve gives its reason', () => {
  assert.match(videoSection, /useActionState\(retryVideoAction/);
  assert.match(videoSection, /useActionState\(changeVoiceAction/);
  assert.match(videoSection, /Use this voice and remake my video/);
  assert.match(videoSection, /const showChange = !approved && /);
  assert.match(videoSection, /name="version" value=\{version\}/);
  assert.match(client, /blockedReason: string \| null/);
  assert.match(client, /disabled=\{pending \|\| blockedReason !== null\}/);
  assert.match(page, /blockedReason=\{approval\.ok \? null : approval\.message\}/);
  assert.match(page, /view\.video/);
});

test('the screen never says the video is coming later', () => {
  for (const [name, src] of [['page', page], ['client', client], ['voice cards', voiceCards], ['video section', videoSection], ['ad section', code(read('./AdSection.tsx'))], ['guide', code(read('./Guide.tsx'))], ['view', code(read('./view.ts'))]] as const) {
    assert.doesNotMatch(src, /coming soon|later release|arrives soon|Video arrives|videoText|videoSlotText/i, name);
  }
});

test('the new actions keep the rules: the owner is the session’s, and only a pack id, a voice, a version and a file name come from the browser', () => {
  for (const fn of ['changeVoiceAction', 'retryVideoAction']) {
    const body = actions.slice(actions.indexOf(`export async function ${fn}`));
    assert.match(body.slice(0, 400), /revalidatePath\(ADS_PATH\)/, fn);
  }
  assert.match(actions, /pollPackAction\(packId: string\)/);
  assert.match(actions, /videoUrlAction\(adId: string, fileName: string\)/);
  assert.match(actions, /changeVoice,\s+retryVideo,/);
  // The server never reads a new voice, owner or cost from anywhere but the form's own fields.
  assert.doesNotMatch(actions, /formData\.get\('(owner|cost|price|amount|free)/i);
});

test('no new activity kind is added for the video', async () => {
  const { isActivityKind } = await import('../../../lib/activity/kinds.ts');
  for (const k of ['ad_voice_changed', 'ad_video_retried', 'ad_video_ready']) assert.equal(isActivityKind(k), false, k);
});
