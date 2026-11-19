/**
 * Review R4 (R4-34): the guard for Review R3's R3-3 (R2-94). The reveal is
 * recorded and stamped viewed BEFORE its cards are priced, so the welcome
 * price is on the first paint and the first tap is quoted exactly as the
 * server will charge it. That promise lives in how two files are put
 * together, so it is pinned by reading the source: an edit that prices the
 * cards first, or stops the reveal page passing the hook, fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('R3-3: loadIntelligence awaits beforePricing before it reads the offer prices', () => {
  const src = code(read('src/lib/intelligence/view-server.ts'));
  const hook = src.indexOf('await input.beforePricing(');
  const pricing = src.indexOf('offerPricingFor(user.id');
  assert.ok(hook > 0, 'loadIntelligence awaits input.beforePricing');
  assert.ok(pricing > 0, 'loadIntelligence prices the cards with offerPricingFor');
  assert.ok(hook < pricing, 'the reveal is recorded and stamped before the cards are priced');
});

test('R3-3: the reveal page passes a beforePricing that records the reveal and stamps it viewed', () => {
  const src = code(read('src/app/welcome/reveal/page.tsx'));
  const call = src.indexOf('loadIntelligence({');
  assert.ok(call > 0);
  const end = src.indexOf('intelligenceCards(', call);
  assert.ok(end > call);
  const args = src.slice(call, end);
  assert.match(args, /beforePricing:/);
  const hook = args.slice(args.indexOf('beforePricing:'));
  assert.match(hook, /recordReveal\(/, 'the reveal is recorded inside the hook');
  assert.match(hook, /markRevealViewed\(/, 'the reveal is stamped viewed inside the hook');
  // Never stamped again after the call (that was the bug: priced first, stamped after).
  assert.doesNotMatch(src.slice(end), /markRevealViewed\(/);
});
