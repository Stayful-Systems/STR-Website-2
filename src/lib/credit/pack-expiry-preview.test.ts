import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { packExpirySummary } from './pack-expiry-preview.ts';

/**
 * Review R4 (R4-31): the starter-pack expiry preview on /admin/weekly-active (never /admin/billing, Batch 31a's).
 * The action is a SOURCE-TEXT PIN: it imports next/navigation and the Supabase server client.
 */

const read = (p: string) => readFileSync(new URL(p, import.meta.url).pathname, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('the preview as totals: grants, members and pence that would expire, the pack bonuses among them, and those lifted', () => {
  const s = packExpirySummary({
    expire: [
      { user: 'a', scope: 'pack_bonus', remainingPence: 1_000 },
      { user: 'a', scope: null, remainingPence: 250 },
      { user: 'b', scope: 'pack_bonus', remainingPence: 500 },
    ],
    lift: [{ user: 'c', remainingPence: 1_500 }],
  });
  assert.deepEqual(s, { expire: { grants: 3, members: 2, pence: 1_750, packBonuses: 2, packBonusPence: 1_500 }, lift: { grants: 1, members: 1, pence: 1_500 } });
  assert.ok(!JSON.stringify(s).includes('"a"'), 'no member is named');
});

test('the preview action requires an admin and only previews (the sweep’s dry run): it never expires, lifts or grants', () => {
  const src = read('../../app/admin/weekly-active/actions.ts');
  const body = src.slice(src.indexOf('export async function packExpiryPreviewAction'));
  assert.ok(body.indexOf('await requireAdmin();') >= 0 && body.indexOf('await requireAdmin();') < body.indexOf('previewDueGrants('), 'the admin check comes first');
  assert.doesNotMatch(src, /expireDueGrants|ensureAnnualMonthlyGrant|syncUnitCosts/, 'nothing that writes');
  assert.match(read('../../app/admin/weekly-active/WeeklyActiveView.tsx'), /<PackExpiryPreview \/>/);
  // Not on /admin/billing.
  for (const f of readdirSync(new URL('../../app/admin/billing', import.meta.url).pathname, { recursive: true }) as string[]) {
    if (!/\.(ts|tsx)$/.test(f)) continue;
    assert.doesNotMatch(read(`../../app/admin/billing/${f}`), /PackExpiryPreview|packExpiryPreviewAction/, f);
  }
});
