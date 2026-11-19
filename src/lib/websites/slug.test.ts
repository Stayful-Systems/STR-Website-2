import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { RESERVED_SLUGS, freeSlug, isReservedSlug, isValidSlug, makeSlug, slugProblem } from './slug.ts';

test('a valid slug is lowercase a-z, 0-9 and hyphens, 3 to 40 characters', () => {
  for (const ok of ['acme', 'acme-lettings', 'a1b', 'x'.repeat(40), 'abc-123']) assert.equal(slugProblem(ok), null, ok);
  assert.equal(slugProblem('ab'), 'too_short');
  assert.equal(slugProblem('x'.repeat(41)), 'too_long');
  for (const bad of ['Acme', 'acme lettings', 'acme_lettings', 'acme.co', 'acmé', 'acme/fees']) assert.equal(slugProblem(bad), 'bad_characters', bad);
  assert.equal(slugProblem('-acme'), 'edge_hyphen');
  assert.equal(slugProblem('acme-'), 'edge_hyphen');
  assert.equal(slugProblem(''), 'empty');
  assert.equal(slugProblem(undefined), 'empty');
  assert.equal(isValidSlug('acme-lettings'), true);
  assert.equal(isValidSlug('Admin'), false);
});

test('reserved words are refused, in any case', () => {
  for (const r of ['admin', 'api', 'leads', 'login', 'www', 'stayful', 'Admin']) assert.equal(isReservedSlug(r), true, r);
  assert.equal(slugProblem('admin'), 'reserved');
  assert.equal(slugProblem('leads'), 'reserved');
  assert.equal(slugProblem('login'), 'reserved');
  assert.equal(isReservedSlug('acme'), false);
});

test('every top-level route in src/app is reserved', () => {
  const root = new URL('../../app/', import.meta.url);
  const names = new Set<string>();
  const walk = (dir: URL) => {
    for (const name of readdirSync(dir)) {
      const child = new URL(`${name}/`, dir);
      if (!statSync(new URL(name, dir)).isDirectory()) continue;
      if (name.startsWith('(') && name.endsWith(')')) walk(child);
      else if (!name.startsWith('_') && !name.startsWith('[') && !name.startsWith('@')) names.add(name);
    }
  };
  walk(root);
  assert.ok(names.size > 10, 'found the routes');
  for (const n of names) assert.ok(RESERVED_SLUGS.has(n), `top-level route "${n}" is not in RESERVED_SLUGS`);
});

test('makeSlug turns a company name into a slug', () => {
  assert.equal(makeSlug('Acme Lettings Ltd'), 'acme-lettings-ltd');
  assert.equal(makeSlug("  O'Neil & Sons  "), 'o-neil-and-sons');
  assert.equal(makeSlug('Café Résidences'), 'cafe-residences');
  assert.equal(makeSlug('---'), '');
  assert.equal(makeSlug(42), '');
  const long = makeSlug('word '.repeat(30));
  assert.ok(long.length <= 40 && !long.endsWith('-'));
  assert.equal(slugProblem(makeSlug('Stayful Lettings')), null);
});

test('freeSlug skips taken, reserved and too-short slugs', () => {
  assert.equal(freeSlug('Acme Lettings', []), 'acme-lettings');
  assert.equal(freeSlug('Acme Lettings', ['acme-lettings']), 'acme-lettings-2');
  assert.equal(freeSlug('Acme Lettings', new Set(['acme-lettings', 'acme-lettings-2'])), 'acme-lettings-3');
  assert.equal(freeSlug('Admin', []), 'admin-2');
  assert.equal(freeSlug('ab', []), 'ab-2');
  assert.equal(freeSlug('!!!', []), null);
  const long = 'x'.repeat(40);
  const c = freeSlug(long, [long]);
  assert.ok(c && c.length <= 40 && c.endsWith('-2'));
});
