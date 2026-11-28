import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import sharp from 'sharp';
import { carouselName, CAROUSEL_CARD_W, phoneFrameLabels } from './ld-images-plan.ts';
import { renderLdTexts } from './ld-angles.ts';

/** Batch 55 step 5 (Phase 2): the lead database pictures, drawn for real (Satori + Resvg), no network. */

type LdImages = typeof import('./ld-images.tsx');
let loaded: Promise<LdImages> | null = null;
function load(): Promise<LdImages> {
  if (!loaded) {
    loaded = (async () => {
      const require = createRequire(import.meta.url);
      const ogPath = require.resolve('next/og.js');
      const sharpPath = require.resolve('sharp');
      const outfile = path.join(mkdtempSync(path.join(tmpdir(), 'ld-images-')), 'ld-images.cjs');
      await build({ entryPoints: [fileURLToPath(new URL('./ld-images.tsx', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile, jsx: 'automatic', logLevel: 'silent', alias: { 'next/og': ogPath, sharp: sharpPath }, external: [ogPath, sharpPath] });
      return require(outfile) as LdImages;
    })();
  }
  return loaded;
}

async function page(): Promise<Uint8Array> {
  return new Uint8Array(await sharp({ create: { width: 595, height: 842, channels: 3, background: { r: 245, g: 244, b: 237 } } }).png().toBuffer());
}

test('3a carousel: one report page per card, whole, on the base; then the CTA card; three sizes each', async () => {
  const m = await load();
  const p = await page();
  const captions = renderLdTexts({ angle: '3a', brand: { company: 'Harbour & Pine', area: 'Leicester', feePct: null }, figure: null }).screenLines;
  const out = await m.renderCarousel({ pages: [p, p, p].map((png) => ({ png, width: 595, height: 842 })), captions, brand: { company: 'Harbour & Pine', brandColour: '#1F4E79', logoUrl: null }, base: 'cream' });
  assert.equal(out.length, 4 * 3);
  assert.deepEqual(out.slice(0, 3).map((o) => o.name), [carouselName(1, '1x1'), carouselName(1, '4x5'), carouselName(1, '9x16')]);
  for (const o of out) {
    const meta = await sharp(Buffer.from(o.png)).metadata();
    assert.equal(meta.width, o.width);
    assert.equal(meta.height, o.height);
  }
  // The corner is the cream base, not the brand colour.
  const raw = await sharp(Buffer.from(out[2].png)).removeAlpha().raw().toBuffer();
  assert.deepEqual([raw[0], raw[1], raw[2]], [0xf5, 0xf4, 0xed]);
  assert.ok(CAROUSEL_CARD_W <= 960);
});

test('5b phone frames: drawn, empty then filled, the size of the phone at 2x', async () => {
  const m = await load();
  const frames = await m.renderPhoneFrames({ company: 'Harbour & Pine', brandColour: '#1F4E79', logoUrl: null, areaLabel: 'Leicester', bedrooms: 3 });
  assert.equal(frames.length, 2);
  for (const f of frames) {
    const meta = await sharp(Buffer.from(f)).metadata();
    assert.equal(meta.width, 780);
    assert.equal(meta.height, 1688);
  }
  assert.notDeepEqual(frames[0], frames[1]);
});

test('the picture measure of a PNG: 64 bins summing to 1, a 32x32 thumbnail', async () => {
  const m = await load();
  const s = await m.measurePng(await page());
  assert.equal(s.hist.length, 64);
  assert.equal(s.thumb.length, 1024);
  assert.ok(Math.abs(s.hist.reduce((a, b) => a + b, 0) - 1) < 1e-6);
});

test('the drawn calculator uses LeadForm.tsx’s own labels, word for word', () => {
  const form = readFileSync(new URL('../websites/LeadForm.tsx', import.meta.url), 'utf8');
  const l = phoneFrameLabels();
  for (const k of ['step', 'address', 'addressPlaceholder', 'postcode', 'bedrooms', 'guests', 'button'] as const) assert.ok(form.includes(l[k]), l[k]);
});
