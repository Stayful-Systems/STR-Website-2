import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dedupeKeyFor } from '../meta/events.ts';

/**
 * Review R4 (Zac, 19 Nov 2026): a member's first £2 buy-to-let report counts
 * as Meta's FirstReport, once per member, never on a failure.
 *
 * The once-only part is real: the key is per member and shared with the
 * analyser and the Full analysis, and recordConversion inserts it once
 * (an existing key, or a lost race, records nothing). Where report-server.ts
 * records it is a SOURCE-TEXT PIN: the file imports `server-only` and the
 * Supabase client, so the report cannot run under node --test.
 */

const read = (p: string) => readFileSync(new URL(p, import.meta.url).pathname, 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('a first BTL report records FirstReport once, never twice', () => {
  // One key per member, whichever report comes first: a second BTL report, or an analysis after it, records nothing.
  assert.equal(dedupeKeyFor('FirstReport', { userId: 'member-1' }), 'FirstReport:member-1');
  assert.equal(dedupeKeyFor('FirstReport', { userId: 'member-1' }), dedupeKeyFor('FirstReport', { userId: 'member-1' }));
  assert.notEqual(dedupeKeyFor('FirstReport', { userId: 'member-1' }), dedupeKeyFor('FirstReport', { userId: 'member-2' }));

  // recordConversion records a key once: it stops on an existing row, and its insert ignores a duplicate.
  const conversions = strip(read('../meta/conversions.ts'));
  const record = conversions.slice(conversions.indexOf('export async function recordConversion'), conversions.indexOf('async function repeatFacts'));
  assert.match(record, /const key = dedupeKeyFor\(input\.name, \{ userId: input\.userId \}\);/);
  assert.match(record, /if \(existing\) return;/);
  assert.match(record, /onConflict: 'dedupe_key', ignoreDuplicates: true/);
  assert.match(record, /if \(!inserted \|\| inserted\.length === 0\) return;/);

  // The BTL report records it exactly once, for the member, only after the report is written and marked complete.
  const src = strip(read('./report-server.ts'));
  const calls = [...src.matchAll(/recordConversion\(/g)];
  assert.equal(calls.length, 1, 'one FirstReport call');
  assert.match(src, /await recordConversion\(\{ name: 'FirstReport', userId: input\.userId \}\);/);
  const at = src.indexOf("recordConversion({ name: 'FirstReport'");
  const saved = src.indexOf("from('btl_reports').insert(");
  const complete = src.indexOf("await finish('complete'");
  const okReturn = src.indexOf('return { ok: true, reportId, purchaseId');
  assert.ok(saved > 0 && complete > saved && at > complete && okReturn > at, 'after the report is written and complete, before the success answer');
  // Never on a failure: not in the no-charge failure path, and not in the catch.
  const failNoCharge = src.slice(src.indexOf('const failNoCharge'), src.indexOf('try {', src.indexOf('const failNoCharge')));
  assert.doesNotMatch(failNoCharge, /recordConversion/);
  const catchBlock = src.slice(okReturn, src.indexOf('const SOLD_MONTHS'));
  assert.doesNotMatch(catchBlock, /recordConversion/);
  // The analyser and the Full analysis record the same event name, so the key is the same.
  assert.match(read('../../app/api/analyse/route.ts'), /recordConversion\(\{ name: 'FirstReport', userId,/);
  assert.match(read('../../app/api/deals/[id]/analysis/run/route.ts'), /recordConversion\(\{ name: 'FirstReport', userId: claim\.purchase\.buyer_id/);
});
