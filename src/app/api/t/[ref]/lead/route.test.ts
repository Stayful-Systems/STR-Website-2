import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Batch 37 phase 6 (review fix): source pins for the exported-form route. The route needs a
 * database, so what is held here is its shape: a plain urlencoded form in, a 303 out to our own
 * thank-you page, no JSON, no Turnstile, no dependence on the site being live, and no log line
 * that carries the body. What intake does with the post is pinned in transfer-intake.test.ts.
 */

const src = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');

test('the route takes a small urlencoded form only and answers with a 303', () => {
  assert.match(src, /application\/x-www-form-urlencoded/);
  assert.match(src, /MAX_BODY_BYTES/);
  assert.match(src, /status: 303/);
  assert.match(src, /\/t\/\$\{ref\}\/thanks\?r=\$\{outcome\}/);
  assert.doesNotMatch(src, /request\.json\(\)/);
});

test('the route needs no Turnstile and does not read the site status', () => {
  // Code only: the header comment says "no Turnstile".
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /turnstile/i);
  assert.doesNotMatch(code, /===?\s*['"]live['"]/);
});

test('no log line carries the form body, the form fields or the address', () => {
  const logs = src.split('\n').filter((l) => /console\.(log|error|warn|info)/.test(l));
  assert.ok(logs.length > 0);
  for (const l of logs) assert.doesNotMatch(l, /\bform\b|\bbody\b|\braw\b|email|address|postcode|phone/i, l);
});
