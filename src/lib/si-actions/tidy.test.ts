import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Review R4 (R4-13): the nightly tidy's dry run (/api/internal/si-actions?dry=1) shows exact counts, never a page
// of rows capped at 1,000, so Zac sees what the real run will touch. It still writes nothing.
test('the si-actions dry run counts with count: exact (a head request), not a capped row list', () => {
  const src = readFileSync(new URL('./run-server.ts', import.meta.url), 'utf8');
  const tidy = src.slice(src.indexOf('export async function tidyInstructions'), src.indexOf('export async function recordReport'));
  const dry = tidy.slice(tidy.indexOf('if (!o.apply)'), tidy.indexOf('return { cancelled, expired, closed, snapshots };'));
  assert.equal((dry.match(/select\('id', \{ count: 'exact', head: true \}\)/g) ?? []).length, 4, 'all four counts are exact');
  assert.doesNotMatch(dry, /\.limit\(/);
  assert.doesNotMatch(dry, /\.update\(|\.insert\(|\.delete\(|moveSteps/, 'the dry run writes nothing');
});
