import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Review R4 (R4-31): the nightly si-actions tidy's Dry run and Run on /admin/intelligence/actions, as the #164 buttons.
 * SOURCE-TEXT PINS: the action imports next/navigation and the Supabase server client, and run-server.ts server-only.
 */

const read = (p: string) => readFileSync(new URL(p, import.meta.url).pathname, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('the tidy action requires an admin; Dry run calls with apply: false (which writes nothing), only "apply=1" runs it', () => {
  const src = read('../../app/admin/intelligence/actions/actions.ts');
  const body = src.slice(src.indexOf('export async function tidyInstructionsAction'));
  assert.ok(body.indexOf('await requireAdmin();') >= 0 && body.indexOf('await requireAdmin();') < body.indexOf('tidyInstructions('), 'the admin check comes first');
  assert.match(body, /const apply = formData\.get\('apply'\) === '1';/, 'anything but "1" (the Dry run button sends "0") is apply: false');
  assert.match(body, /await tidyInstructions\(\{ apply \}\)/);
  assert.match(src, /if \(!isAdminEmail\(user\.email\)\) notFound\(\);/);
  // The panel's buttons: Dry run sends 0, Run sends 1 (offered only after a dry run).
  const panel = read('../../app/admin/intelligence/actions/TidyPanel.tsx');
  assert.match(panel, /name="apply" value="0"/);
  assert.match(panel, /name="apply"\s+value="1"\s+disabled=\{pending \|\| !dryRunDone\}/);
  assert.match(read('../../app/admin/intelligence/actions/page.tsx'), /<TidyPanel \/>/);
  // And what the Dry run calls writes nothing (tidyInstructions returns its counts before any update).
  const runServer = read('./run-server.ts');
  const fn = runServer.slice(runServer.indexOf('export async function tidyInstructions'), runServer.indexOf('export', runServer.indexOf('export async function tidyInstructions') + 10));
  const dry = fn.slice(fn.indexOf('if (!o.apply) {'), fn.indexOf('return { cancelled, expired, closed, snapshots };') + 1);
  assert.ok(dry.length > 0);
  assert.doesNotMatch(dry, /\.update\(|\.insert\(|\.delete\(|moveSteps/, 'the dry run only counts');
  assert.ok(fn.indexOf('return { cancelled, expired, closed, snapshots };') < fn.indexOf('.update('), 'it returns before the first write');
});
