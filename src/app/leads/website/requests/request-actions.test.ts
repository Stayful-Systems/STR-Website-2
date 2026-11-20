import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** Batch 36 (Phase 5): source pins for the change-request action and page. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const actions = strip(readFileSync(new URL('./request-actions.ts', import.meta.url), 'utf8'));
const page = strip(readFileSync(new URL('./page.tsx', import.meta.url), 'utf8'));
const form = strip(readFileSync(new URL('./RequestForm.tsx', import.meta.url), 'utf8'));

test('the action starts with websiteActor() and reads only the text and the screenshot from the form', () => {
  assert.match(actions, /^'use server';/m);
  assert.ok(actions.indexOf('websiteActor()') > 0 && actions.indexOf('websiteActor()') < actions.indexOf('formData.get'), 'the owner is found before the form is read');
  const reads = [...actions.matchAll(/formData\.get\('([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(reads.sort(), ['body', 'screenshot']);
  assert.doesNotMatch(actions, /formData\.get\('(website|user|owner|funnel|request|id)/i);
  // The owner and the site come from the signed-in actor.
  assert.match(actions, /ownerId: r\.actor\.userId, websiteId: r\.actor\.site\.id/);
});

test('the action exports only the action and its state type, and never logs', () => {
  assert.deepEqual([...actions.matchAll(/export (async function|interface|const|function) (\w+)/g)].map((m) => m[2]), ['RequestFormState', 'sendRequestAction']);
  assert.doesNotMatch(actions, /console\./);
});

test('the page lists only the signed-in owner\'s requests and sends everyone else away', () => {
  assert.match(page, /await websiteActor\(\)/);
  assert.match(page, /listOwn\(r\.actor\.userId\)/);
  assert.doesNotMatch(page, /searchParams|params\b/, 'no id comes from the address');
  assert.match(page, /redirect\("\/leads"\)/);
  assert.match(page, /export const dynamic = "force-dynamic"/);
  assert.match(page, /noindex|index: false/);
});

test('the form posts the text and the screenshot and nothing else', () => {
  assert.match(form, /name="body"/);
  assert.match(form, /name="screenshot"/);
  assert.equal([...form.matchAll(/\bname="(\w+)"/g)].length, 2);
  assert.match(form, /maxLength=\{MAX\}/);
  assert.match(form, /image\/png,image\/jpeg/);
});
