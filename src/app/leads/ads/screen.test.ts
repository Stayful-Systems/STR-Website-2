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
const page = code(read('./page.tsx'));
const startForm = code(read('./StartForm.tsx'));
const voicePicker = code(read('./VoicePicker.tsx'));
const videoBlock = code(read('./VideoBlock.tsx'));
const screens = code(read('./Screens.tsx'));
const gallery = code(read('./Gallery.tsx'));
const downloads = code(read('./Downloads.tsx'));
const wizard = code(read('./guide/GuideWizard.tsx'));
const live = code(read('./LiveActions.tsx'));
const context = code(read('./ActionsContext.tsx'));

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
  assert.doesNotMatch(wizard, /recordCopy\([^)]*\.text/);
  assert.match(wizard, /recordCopy\(adId, item\.kind, item\.index\)/);
});
test('copy is instant: the clipboard first, the log after it and not waited for', () => {
  const fn = wizard.slice(wizard.indexOf('async function copy()'), wizard.indexOf('return (', wizard.indexOf('async function copy()')));
  assert.ok(fn.indexOf('navigator.clipboard.writeText(item.text)') >= 0);
  assert.ok(fn.indexOf('navigator.clipboard.writeText') < fn.indexOf('recordCopy'), 'clipboard before the log');
  assert.match(fn, /void recordCopy\(/);
  assert.doesNotMatch(fn, /await recordCopy/);
  assert.match(fn, /\.catch\(/);
  // The text is copied exactly as stored.
  assert.doesNotMatch(wizard, /item\.text\.trim\(\)|writeText\([^)]*trim/);
});
test('the page is the owner’s only, eligibility decides what it shows, and the admin preview passes admin through', () => {
  assert.match(page, /ownerIdOrNull\(user\)/);
  assert.match(page, /redirect\("\/leads"\)/);
  assert.match(page, /packEligibility\(user\.id, \{ admin \}\)/);
  assert.match(page, /isAdminEmail\(user\.email\)/);
  assert.match(page, /listPackForOwner\(ownerId\)/, 'the ads are read for the session’s owner id');
  assert.doesNotMatch(page, /searchParams|params\b/, 'nothing in the address chooses whose ads are shown');
  assert.match(page, /export const maxDuration = 60/);
  // Every screen that acts is inside the provider of the real actions.
  assert.match(page, /<LiveActions>/);
  assert.match(live, /generate: generatePackAction/);
});
test('the page picks the stage from the ads and the video, links to the guide page, and shows the labelled example', () => {
  assert.match(page, /stageOf\(screen\.kind, videoState\)/);
  assert.match(screens, /GUIDE_PATH/);
  assert.match(screens, /Put my ads on Facebook/);
  assert.match(screens, /figure\.sentence/);
  assert.match(page, /figureCallout\(pack\.figures\)/);
  assert.match(gallery, /ad\.video \?/);
  // Only the pictures that are shown are given view links.
  assert.match(page, /previewPathsOf\(a\.files\)/);
});
test('the form: the area list, one voice picker, photos hidden until asked for, the no-logo tick only without a logo, a button that sticks to the bottom', () => {
  assert.match(startForm, /AREA_LABEL/);
  assert.match(startForm, /MAX_PHOTOS = 4/);
  assert.match(startForm, /accept="image\/jpeg,image\/png"/);
  assert.match(startForm, /<details[\s\S]*?<summary[^>]*>\{PHOTOS_TITLE\}/, 'photos sit under "Add your own photos (optional)"');
  assert.match(startForm, /name="photoRef"/);
  assert.match(startForm, /name="typeOnly"/);
  assert.match(startForm, /!p\.hasLogo/);
  assert.match(startForm, /START_BUTTON/);
  assert.match(startForm, /<StickyBar>\{submit\}<\/StickyBar>/);
  assert.match(startForm, /useState<VoiceKey>\(DEFAULT_VOICE_KEY\)/);
  assert.match(startForm, /<VoicePicker name="voiceKey" value=\{voiceKey\}/);
  assert.match(startForm, /again \? null : \(/, 'making new ads keeps the voice and offers no voice picker');
  assert.match(actions, /voiceKey: text\(formData\.get\('voiceKey'\)\)/);
});

test('the looks-good button pins the version on screen and stays off until the video is ready', () => {
  assert.match(screens, /name="version" value=\{version\}/);
  assert.match(screens, /disabled=\{pending \|\| !approval\.ok\}/);
  assert.match(screens, /APPROVE_BUTTON/);
  assert.match(page, /approval=\{approvalVm\(view\)\}/);
  assert.match(page, /view\.video/);
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
  assert.match(read('../../../../next.config.ts'), /"\/leads\/ads": AD_PACK_FONTS/);
});
test('the kinds the screen logs are registered', async () => {
  const { isActivityKind } = await import('../../../lib/activity/kinds.ts');
  assert.equal(isActivityKind('ad_pack_approved'), true);
  assert.equal(isActivityKind('ad_text_copied'), true);
  assert.match(actions, /liveDeps/);
});

// ── 38b: the voice step, the video and the poll ──

test('the voice picker: three cards with a play button each, one hidden audio that loads only when asked, a radio choice posted as voiceKey', () => {
  assert.match(voicePicker, /<audio ref=\{audio\} preload="none"/);
  assert.match(voicePicker, /type="radio"/);
  assert.match(voicePicker, /role="radiogroup"/);
  assert.match(voicePicker, /voiceCards\(\)/);
  assert.match(voicePicker, /aria-label=\{playing === v\.key \? `Stop \$\{v\.label\}` : `Hear \$\{v\.label\}`\}/);
  assert.doesNotMatch(voicePicker, /new Audio\(|<script|createElement\("script"\)/, 'no script, no third-party player');
});
test('the video block polls through the actions, reloads once, stops on leaving and gives up', () => {
  assert.match(videoBlock, /^"use client";/);
  assert.match(videoBlock, /ask\(packId\)/);
  assert.match(videoBlock, /pollStep\(\{ startedMs, nowMs: Date\.now\(\), poll, versionChanged \}\)/);
  assert.match(videoBlock, /router\.refresh\(\)/);
  assert.match(videoBlock, /return \(\) => \{\s*stopped = true;\s*if \(timer\) clearTimeout\(timer\);/, 'stops on unmount');
  assert.match(videoBlock, /VIDEO_SLOW_TEXT/);
  assert.match(videoBlock, /POLL_INTERVAL_MS/);
  // The making sentence says the page can be closed and an email follows.
  const view = code(read('./view.ts'));
  assert.match(view, /VIDEO_MAKING_TEXT = 'Your video is being made\. This takes about 5 to 10 minutes\. You can close this page: we’ll email you when it’s ready\.'/);
});
test('the player: a video element with controls, inline on a phone, metadata only, and a fresh link when the first one runs out', () => {
  assert.match(videoBlock, /<video[\s\S]*controls[\s\S]*playsInline[\s\S]*preload="metadata"/);
  assert.match(videoBlock, /poster=\{posterUrl\}/);
  assert.match(videoBlock, /onError=\{\(\) => void refresh\(\)\}/);
  assert.match(videoBlock, /videoUrl\(adId, file\.name\)/);
  assert.match(videoBlock, /MAX_LINK_REFRESHES/);
});

test('downloads: one tap saves one size, through the owner-checked download action, and the gallery offers them behind one Download button', () => {
  assert.match(downloads, /download\(adId, name\)/);
  assert.match(downloads, /Promise\.all\(fileNames\.map/);
  assert.match(gallery, /<DownloadMenu adId=\{ad\.id\} groups=\{ad\.downloads\}/);
  assert.match(downloads, /Download\s*<span aria-hidden>/);
  assert.match(screens, /Download everything/);
});
test('failed videos offer the right button, the voice change sits under More options, and an approved ad keeps no voice change', () => {
  assert.match(videoBlock, /useActionState\(retryVideo/);
  assert.match(videoBlock, /useActionState\(changeVoice/);
  assert.match(videoBlock, /VOICE_CHANGE_BUTTON/);
  assert.match(videoBlock, /name="version" value=\{version\}/);
  assert.match(videoBlock, /card\.action === "retry"/);
  assert.match(videoBlock, /card\.action === "change_voice" && voice\.canChange/);
  assert.match(screens, /MORE_OPTIONS_TITLE/);
  assert.match(page, /canChangeVoice=\{stage === "review"\}/);
});
test('the screens never say the video is coming later', () => {
  for (const [name, src] of [['page', page], ['start form', startForm], ['voice picker', voicePicker], ['video block', videoBlock], ['gallery', gallery], ['screens', screens], ['guide', wizard], ['view', code(read('./view.ts'))]] as const) {
    assert.doesNotMatch(src, /coming soon|later release|arrives soon|Video arrives|videoText|videoSlotText/i, name);
  }
});

test('the screens get their actions from one context, so the preview can use pretend ones', () => {
  for (const [name, src] of [['start form', startForm], ['video block', videoBlock], ['screens', screens], ['downloads', downloads], ['guide', wizard]] as const) {
    assert.doesNotMatch(src, /from "\.\/actions"|from "\.\.\/actions"/, `${name} does not import the server actions itself`);
    assert.match(src, /useAdsActions\(\)/, name);
  }
  assert.match(context, /createContext/);
  assert.match(live, /^"use client";/);
  assert.match(live, /from "\.\/actions"/);
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
