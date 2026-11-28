import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildBriefV2, briefV2Problems, outputsV2, posterV2, type LoupeTarget } from './brief-v2.ts';
import { enqueueRender } from './render-core.ts';
import { MemoryRenderStore } from './render-test-store.ts';
import { RENDER_COLUMNS, RENDER_KINDS, kindOf, toRenderRow } from './render-store.ts';
import type { BriefScript } from './captions.ts';

const SCRIPT: BriefScript = {
  lines: [
    { id: 'L1', text: 'Landlords in Leicester, here is a free report.', start: 0, end: 2 },
    { id: 'L2', text: 'It shows a short let against a long let.', start: 2, end: 4 },
    { id: 'L3', text: 'Get your free income report.', start: 4, end: 6 },
  ],
  words: [
    { text: 'Landlords', start: 0, end: 0.5, line: 0 },
    { text: 'It', start: 2, end: 2.2, line: 1 },
    { text: 'Get', start: 4, end: 4.3, line: 2 },
  ],
  duration: 6.4,
} as unknown as BriefScript;

const LINES = ['Landlords in Leicester: free short-let income report', 'Answer a few questions', 'Your report', 'Short let vs long let', 'Get your free income report'];
const TARGETS: LoupeTarget[] = [
  { page: 0, x: 0.1, y: 0.2, w: 0.8, h: 0.15 },
  { page: 0, x: 0.1, y: 0.45, w: 0.8, h: 0.15 },
  { page: 1, x: 0.1, y: 0.3, w: 0.8, h: 0.15 },
];

function phone() {
  return buildBriefV2({ conceptId: '5b-tenant-leaving', format: 'phone_recording', company: ' Harbour  & Pine ', colour: '#1f4e79', logo: 'assets/logo.png', base: 'cream', screenLines: LINES, figureLabel: 'Example: a typical 3-bed in Leicester, from 14 reports. Every property is different.', reportPages: ['assets/page-1.png', 'assets/page-2.png'], phoneFrames: ['assets/phone-1.png', 'assets/phone-2.png'], targets: TARGETS, script: SCRIPT });
}

test('brief v2: the phone brief carries the concept, format, base, five screen lines, stamp, pages and phone frames', () => {
  const b = phone();
  assert.equal(b.version, 2);
  assert.equal(b.brand.company, 'Harbour & Pine');
  assert.equal(b.brand.colour, '#1F4E79');
  assert.equal(b.base, '#F5F4ED');
  assert.equal(b.stamp, 'Example report');
  assert.equal(b.out_prefix, 'phone');
  assert.deepEqual(b.targets, [], 'the phone video has no loupe stops');
  assert.deepEqual(briefV2Problems(b), [], JSON.stringify(briefV2Problems(b)));
  assert.deepEqual(Object.keys(b).sort(), ['audio', 'base', 'brand', 'concept_id', 'figure_label', 'format', 'out_dir', 'out_prefix', 'phone_frames', 'report_pages', 'screen_lines', 'script', 'stamp', 'targets', 'version']);
});

test('brief v2: the loupe brief has three stops on real pages, no phone frames and no figure', () => {
  const b = buildBriefV2({ conceptId: '17-rules-changed', format: 'loupe', company: 'X', colour: null, logo: null, base: 'white', screenLines: LINES, figureLabel: 'Example: …', reportPages: ['assets/page-1.png', 'assets/page-2.png'], phoneFrames: ['a.png'], targets: TARGETS, script: SCRIPT });
  assert.equal(b.base, '#FFFFFF');
  assert.equal(b.figure_label, null);
  assert.deepEqual(b.phone_frames, []);
  assert.equal(b.out_prefix, 'loupe');
  assert.deepEqual(briefV2Problems(b), []);
  assert.ok(briefV2Problems({ ...b, targets: TARGETS.slice(0, 2) }).includes('targets'));
  assert.ok(briefV2Problems({ ...b, targets: [{ ...TARGETS[0], page: 5 }, TARGETS[1], TARGETS[2]] }).includes('targets'));
});

test('brief v2: unsafe paths, a missing stamp, wrong line count and no pages are refused', () => {
  const b = phone();
  assert.ok(briefV2Problems({ ...b, report_pages: ['../etc/passwd'] }).includes('report pages'));
  assert.ok(briefV2Problems({ ...b, report_pages: [] }).includes('report pages'));
  assert.ok(briefV2Problems({ ...b, phone_frames: [] }).includes('phone frames'));
  assert.ok(briefV2Problems({ ...b, stamp: '' }).includes('stamp'));
  assert.ok(briefV2Problems({ ...b, screen_lines: LINES.slice(0, 4) }).includes('screen lines'));
  assert.ok(briefV2Problems({ ...b, brand: { ...b.brand, logo: '/abs.png' } }).includes('logo path'));
  assert.ok(briefV2Problems({ ...b, concept_id: 'Bad Id' }).includes('concept'));
});

test('brief v2: the outputs keep the three sizes and their own names', () => {
  assert.deepEqual(outputsV2('loupe').map((o) => [o.name, o.width, o.height]), [['loupe-9x16.mp4', 1080, 1920], ['loupe-4x5.mp4', 1080, 1350], ['loupe-1x1.mp4', 1080, 1080]]);
  assert.equal(posterV2('phone').name, 'phone-poster.png');
});

// ── Render kinds ──

test('render kinds: one row per kind per version; a notice row reads without a kind, as before', async () => {
  const store = new MemoryRenderStore({} as never);
  const n = await enqueueRender(store, { packId: 'p1', version: 1, voiceKey: 'jane' });
  const e = await enqueueRender(store, { packId: 'p1', version: 1, voiceKey: 'jane', kind: 'example_report' });
  const again = await enqueueRender(store, { packId: 'p1', version: 1, voiceKey: 'jane', kind: 'example_report' });
  assert.ok(n.ok && e.ok && again.ok);
  if (n.ok && e.ok && again.ok) {
    assert.notEqual(n.renderId, e.renderId);
    assert.equal(again.inserted, false);
  }
  const notice = await store.getRender('p1', 1);
  assert.ok(notice && !('kind' in notice), 'a notice row has no kind key');
  assert.equal(kindOf((await store.getRender('p1', 1, 'example_report'))!), 'example_report');
  assert.equal(await store.getRender('p1', 1, 'loupe'), null);
  assert.deepEqual(await enqueueRender(store, { packId: 'p1', version: 1, voiceKey: 'jane', kind: 'carousel' as never }), { ok: false, code: 'invalid_input' });
});

test('render kinds: toRenderRow keeps a kind only when it is not notice; RENDER_COLUMNS reads it', () => {
  const base = { id: 'r', pack_id: 'p', version: 1, voice_key: 'jane', state: 'queued', attempts: 0, cost_pence: 0, created_at: 'x', updated_at: 'y' };
  assert.ok(!('kind' in toRenderRow({ ...base, kind: 'notice' })));
  assert.equal(toRenderRow({ ...base, kind: 'loupe' }).kind, 'loupe');
  assert.ok(!('kind' in toRenderRow({ ...base, kind: 'nope' })));
  assert.ok(RENDER_COLUMNS.split(', ').includes('kind'));
});

test('render kinds: the schema block adds the column, its check word for word, and the (pack, version, kind) key', () => {
  const sql = readFileSync(new URL('../../../supabase/schema.sql', import.meta.url), 'utf8');
  const block = sql.slice(sql.indexOf('-- Batch 55 step 5 (Phase 2)'));
  assert.ok(block.length > 100, 'the Phase 2 block is in schema.sql');
  assert.match(block, /add column if not exists kind text not null default 'notice'/);
  const m = /ad_pack_renders_kind_check\s+check \(kind in \(([^)]*)\)\)/.exec(block);
  assert.ok(m);
  assert.deepEqual(m[1].split(',').map((s) => s.trim().replace(/'/g, '')), [...RENDER_KINDS]);
  assert.match(block, /unique \(pack_id, version, kind\)/);
  // The old key is dropped only inside the guard that adds the new one.
  assert.match(block, /if not exists[\s\S]*add constraint ad_pack_renders_pack_version_kind_key[\s\S]*drop constraint if exists ad_pack_renders_pack_version_key;\s*end if;/);
  // The live store's upsert names the new key.
  const live = readFileSync(new URL('./render-store-server.ts', import.meta.url), 'utf8');
  assert.match(live, /onConflict: 'pack_id,version,kind'/);
});
