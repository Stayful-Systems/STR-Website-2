import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// Batch 38b: the video renderer in ad-render/ is brand-neutral. Nothing in it may carry another
// business's name, example figures, fee line or asset names, and it ships no stray binaries.

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', 'ad-render');

const BINARY = new Set(['.ttf', '.otf', '.woff', '.woff2', '.mp3', '.wav', '.mp4', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.pyc']);
const ALLOWED_FONTS = new Set(['Anton-Regular.ttf', 'Archivo-Medium.ttf', 'Archivo-SemiBold.ttf', 'OFL.txt']);
const MAX_BYTES = 2 * 1024 * 1024;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join('/');

// Case-insensitive. The five example figures are matched as whole numbers (with or without the
// thousands comma) so a timing such as 12.939 or a longer number does not trip them.
const FORBIDDEN_TEXT: { name: string; re: RegExp }[] = [
  { name: 'the business name', re: new RegExp(['stay', 'ful'].join(''), 'i') },
  { name: 'its example figures', re: /(?<![\d.,])(2,?399|1,?349|3,?097|7,?681|939)(?![\d]|\.\d)/ },
  { name: 'its fee line', re: /15\s*%\s*\+\s*vat/i },
  { name: 'its asset names', re: /(lincoln|york)\d|vosync|ad5_/i },
];

test('ad-render exists and has files', () => {
  assert.ok(walk(ROOT).length > 5);
});

test('no file name carries another business name, figure or asset name', () => {
  for (const f of walk(ROOT)) {
    const name = rel(f);
    for (const { name: what, re } of FORBIDDEN_TEXT) {
      // a file name never holds a figure on its own (a number in a name is not a price), so skip that one
      if (what === 'its example figures') continue;
      assert.doesNotMatch(name, re, `${name} must not contain ${what}`);
    }
  }
});

test('no text file contains another business name, example figure, fee line or asset name', () => {
  for (const f of walk(ROOT)) {
    if (BINARY.has(path.extname(f).toLowerCase())) continue;
    const text = readFileSync(f, 'utf8');
    for (const { name: what, re } of FORBIDDEN_TEXT) {
      assert.doesNotMatch(text, re, `${rel(f)} must not contain ${what}`);
    }
  }
});

test('fonts are only the allowed open-licence files', () => {
  const fonts = walk(path.join(ROOT, 'fonts')).map((f) => path.basename(f));
  assert.deepEqual([...fonts].sort(), [...ALLOWED_FONTS].sort());
  // no font file anywhere else
  for (const f of walk(ROOT)) {
    if (/\.(ttf|otf|woff2?)$/i.test(f)) assert.ok(rel(f).startsWith('fonts/'), `${rel(f)}: fonts live in fonts/`);
  }
});

test('no file over 2 MB except fonts, and no leftover build output', () => {
  for (const f of walk(ROOT)) {
    const name = rel(f);
    assert.doesNotMatch(name, /__pycache__|\.pyc$|(^|\/)out\//, `${name} is build output`);
    if (name.startsWith('fonts/')) continue;
    assert.ok(statSync(f).size <= MAX_BYTES, `${name} is over 2 MB`);
  }
});
