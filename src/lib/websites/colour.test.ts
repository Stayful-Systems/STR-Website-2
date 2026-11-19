import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brandColour, brandColourFromPixels, dominantColour } from './colour.ts';
import { readableOn } from '../funnels/brand.ts';

/** A w x h RGBA image: `fill(x, y)` gives [r,g,b,a]. */
function image(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) px.set(fill(x, y), (y * w + x) * 4);
  }
  return px;
}

test('colour quantiser picks the dominant colour of a synthetic logo', () => {
  // 20x20: white background, a big teal block, a small red mark, black outline column, grey row, transparent corner.
  const px = image(20, 20, (x, y) => {
    if (x === 0) return [0, 0, 0, 255]; // black
    if (y === 0) return [128, 128, 128, 255]; // grey
    if (x >= 17 && y >= 17) return [255, 0, 0, 0]; // transparent red
    if (x >= 15 && y >= 15) return [220, 30, 30, 255]; // small red mark
    if (x >= 3 && x < 13 && y >= 3 && y < 13) return [10, 150, 160, 255]; // teal
    return [255, 255, 255, 255]; // white
  });
  assert.equal(dominantColour(px, 20, 20), '#0a96a0');
});

test('colour quantiser ignores white, black, grey and transparent pixels entirely', () => {
  const white = image(8, 8, () => [250, 250, 250, 255]);
  const black = image(8, 8, () => [5, 5, 5, 255]);
  const grey = image(8, 8, () => [120, 124, 122, 255]);
  const clear = image(8, 8, () => [200, 40, 40, 0]);
  for (const px of [white, black, grey, clear]) assert.equal(dominantColour(px, 8, 8), null);
});

test('colour quantiser: the few coloured pixels win when everything else is background', () => {
  const px = image(10, 10, (x, y) => (x === 5 && y === 5 ? [30, 90, 200, 255] : [255, 255, 255, 255]));
  assert.equal(dominantColour(px, 10, 10), '#1e5ac8');
});

test('colour quantiser accepts plain arrays and rejects a pixel array too short for its size', () => {
  const arr = Array.from(image(4, 4, () => [200, 20, 20, 255]));
  assert.equal(dominantColour(arr, 4, 4), '#c81414');
  assert.equal(dominantColour(arr.slice(0, 10), 4, 4), null);
  assert.equal(dominantColour(arr, 0, 4), null);
  assert.equal(dominantColour(arr, Number.NaN, 4), null);
});

test('colour quantiser samples big images and still finds the colour', () => {
  const px = image(400, 300, (x) => (x < 250 ? [200, 120, 20, 255] : [255, 255, 255, 255]));
  assert.equal(dominantColour(px, 400, 300, { maxSamples: 5000 }), '#c87814');
});

test('brand colour carries the readable text colour from brand.ts', () => {
  assert.deepEqual(brandColour('#0A96A0'), { primary: '#0a96a0', onPrimary: readableOn('#0a96a0') });
  assert.equal(brandColour('#fff')?.primary, undefined);
  assert.equal(brandColour('blue'), null);
  assert.equal(brandColour('#ffee00')?.onPrimary, '#111111');
  assert.equal(brandColour('#112244')?.onPrimary, '#ffffff');
  const fromPx = brandColourFromPixels(image(4, 4, () => [20, 30, 160, 255]), 4, 4);
  assert.equal(fromPx?.onPrimary, '#ffffff');
  assert.equal(brandColourFromPixels(image(4, 4, () => [255, 255, 255, 255]), 4, 4), null);
});
