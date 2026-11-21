import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { devPreviewAllowed } from './guard.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the development preview opens only off Vercel and outside a production build', () => {
  assert.equal(devPreviewAllowed({ NODE_ENV: 'development' }), true);
  assert.equal(devPreviewAllowed({}), true);
  assert.equal(devPreviewAllowed({ NODE_ENV: 'test' }), true);
  assert.equal(devPreviewAllowed({ NODE_ENV: 'production' }), false);
  assert.equal(devPreviewAllowed({ NODE_ENV: 'development', VERCEL: '1' }), false);
  assert.equal(devPreviewAllowed({ VERCEL: 'production' }), false);
  assert.equal(devPreviewAllowed({ NODE_ENV: 'production', VERCEL: '1' }), false);
});

test('the preview page returns not-found before it shows anything, is never cached, and imports no database or server action', () => {
  const page = code(read('./page.tsx'));
  assert.match(page, /export const dynamic = "force-dynamic"/);
  assert.ok(page.indexOf('devPreviewAllowed(process.env)') > 0 && page.indexOf('notFound()') > page.indexOf('devPreviewAllowed(process.env)'));
  assert.ok(page.indexOf('notFound()') < page.indexOf('<Preview'), 'not found comes before the screens');
  for (const file of ['./page.tsx', './Preview.tsx', './fixtures.ts']) {
    const src = code(read(file));
    assert.doesNotMatch(src, /supabase|server-only|from "@\/app\/leads\/ads\/actions"|LiveActions|\/lib\/ad-packs\/(?:generate|store|files|area|eligibility)-server/, file);
  }
});
