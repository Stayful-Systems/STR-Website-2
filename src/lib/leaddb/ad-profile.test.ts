import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signatureHeader } from '../crm/signature.ts';
import { asObject, parseLdCustomerId, verifyInbound } from './inbound.ts';
import {
  areasForSettings,
  changedProfileFields,
  feeForSettings,
  markEdited,
  parseAdProfile,
  parseProfilePushed,
  parseSettingsEdited,
  planProfileFill,
  preferredBedrooms,
  safeLogoUrl,
  shouldApplyProfile,
  type AdProfile,
  type ProfilePushed,
} from './ad-profile.ts';

/**
 * Batch 55 step 5 (Phase 1, 55c A1): the profile call (contract section 13, call 8). The signed door, the strict check of
 * the body, the profileAsOf ordering and the fill rule: only empty fields, or fields still equal to the last pushed value,
 * never a field the customer edited.
 */

const SECRET = 's'.repeat(40);
const NOW = 1_800_000_000;
const env = { SI_LEAD_PUSH_SECRET: SECRET };

const GOOD = {
  logoUrl: 'https://store.example.test/brand/logo.png?token=abc',
  brandColour: '#1F4E79',
  feePct: 18,
  areas: ['Leicester', 'Loughborough'],
  bedrooms: { min: 2, max: 4 },
  profileAsOf: '2026-12-01T10:00:00.000Z',
};

function signed(body: string, over: { secret?: string } = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json', [TIMESTAMP_HEADER]: String(NOW) };
  headers[SIGNATURE_HEADER] = signatureHeader(over.secret ?? SECRET, body, NOW);
  return new Request('https://example.test/api/internal/si/ad-route/profile', { method: 'POST', headers, body });
}

// ── The signed door and the body ──

test('a signed profile body verifies and parses; a wrong signature is 401 before the body is read as a profile', async () => {
  const body = JSON.stringify({ ld_customer_id: '9d6f-cust', profile: GOOD });
  const res = await verifyInbound(signed(body), { env, nowSeconds: NOW });
  assert.equal(res.ok, true);
  if (res.ok) {
    const b = asObject(res.json);
    assert.equal(parseLdCustomerId(b?.ld_customer_id), '9d6f-cust');
    assert.deepEqual(parseAdProfile(b?.profile), { ...GOOD, brandColour: '#1f4e79' });
  }
  const bad = await verifyInbound(signed(body, { secret: 'x'.repeat(40) }), { env, nowSeconds: NOW });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.response.status, 401);
    assert.deepEqual(await bad.response.json(), { ok: false, code: 'unauthorized' });
  }
  const unset = await verifyInbound(signed(body), { env: {}, nowSeconds: NOW });
  assert.equal(!unset.ok && unset.response.status, 404, 'no secret: as if the route did not exist');
});

test('nulls and an empty area list are a valid profile (a customer with none of these)', () => {
  assert.deepEqual(parseAdProfile({ logoUrl: null, brandColour: null, feePct: null, areas: [], bedrooms: null, profileAsOf: GOOD.profileAsOf }), {
    logoUrl: null, brandColour: null, feePct: null, areas: [], bedrooms: null, profileAsOf: GOOD.profileAsOf,
  });
  assert.deepEqual(parseAdProfile({ profileAsOf: GOOD.profileAsOf })?.areas, []);
});

test('a bad profile is refused whole: non-https logo, bad colour, fee out of range, too many or bad areas, bad bedrooms, no time, unknown keys', () => {
  const bad: unknown[] = [
    null, 'x', [], { ...GOOD, profileAsOf: undefined }, { ...GOOD, profileAsOf: 'yesterday' },
    { ...GOOD, logoUrl: 'http://store.example.test/logo.png' }, { ...GOOD, logoUrl: 'ftp://x.test/a.png' }, { ...GOOD, logoUrl: 'not a url' },
    { ...GOOD, logoUrl: 'https://127.0.0.1/logo.png' }, { ...GOOD, logoUrl: 'https://localhost/logo.png' }, { ...GOOD, logoUrl: 'https://user:pw@x.test/a.png' },
    { ...GOOD, logoUrl: 'https://x.test:8443/a.png' }, { ...GOOD, logoUrl: `https://x.test/${'a'.repeat(2050)}` },
    { ...GOOD, brandColour: '1F4E79' }, { ...GOOD, brandColour: '#1F4E7' }, { ...GOOD, brandColour: 'blue' }, { ...GOOD, brandColour: 123 },
    { ...GOOD, feePct: -1 }, { ...GOOD, feePct: 101 }, { ...GOOD, feePct: '18' }, { ...GOOD, feePct: Number.NaN },
    { ...GOOD, areas: 'Leicester' }, { ...GOOD, areas: Array.from({ length: 11 }, (_, i) => `Area ${i}`) }, { ...GOOD, areas: [''] }, { ...GOOD, areas: ['   '] },
    { ...GOOD, areas: ['x'.repeat(81)] }, { ...GOOD, areas: [3] },
    { ...GOOD, bedrooms: { min: 3, max: 2 } }, { ...GOOD, bedrooms: { min: -1, max: 2 } }, { ...GOOD, bedrooms: { min: 1, max: 11 } },
    { ...GOOD, bedrooms: { min: 1.5, max: 2 } }, { ...GOOD, bedrooms: { min: 1 } }, { ...GOOD, bedrooms: { min: 1, max: 2, extra: 1 } }, { ...GOOD, bedrooms: [1, 2] },
    { ...GOOD, company: 'Not part of the profile' },
  ];
  for (const b of bad) assert.equal(parseAdProfile(b), null, JSON.stringify(b)?.slice(0, 120));
  // Exactly 10 areas of 80 characters is the limit, and is fine.
  assert.ok(parseAdProfile({ ...GOOD, areas: Array.from({ length: 10 }, (_, i) => `${i}`.padEnd(80, 'x')) }));
  assert.ok(parseAdProfile({ ...GOOD, feePct: 0 }) && parseAdProfile({ ...GOOD, feePct: 100 }));
  assert.ok(parseAdProfile({ ...GOOD, bedrooms: { min: 0, max: 10 } }));
});

test('safeLogoUrl keeps a plain public https address only', () => {
  assert.equal(safeLogoUrl('https://cdn.example.test/a/logo.png?x=1'), 'https://cdn.example.test/a/logo.png?x=1');
  for (const u of ['http://cdn.example.test/a.png', 'https://intranet/a.png', 'https://box.internal/a.png', 'https://[::1]/a.png', 'https://10.0.0.1/a.png', 'https://a.local/a.png', '', 7]) {
    assert.equal(safeLogoUrl(u), null, String(u));
  }
});

test('profileAsOf ordering is exactly stateAsOf: newer and equal apply, older is stale, nothing held takes anything', () => {
  const held = new Date('2026-12-01T10:00:00.000Z');
  assert.equal(shouldApplyProfile(held, '2026-12-01T10:00:01.000Z'), true);
  assert.equal(shouldApplyProfile(held, '2026-12-01T10:00:00.000Z'), true, 'equal is applied again');
  assert.equal(shouldApplyProfile(held, '2026-12-01T09:59:59.000Z'), false);
  assert.equal(shouldApplyProfile(null, '2020-01-01T00:00:00.000Z'), true);
  assert.equal(shouldApplyProfile(undefined, '2020-01-01T00:00:00.000Z'), true);
});

// ── The fill rule ──

const EMPTY = { logoUrl: null, brandColour: null, areas: [] as string[], managementFeePct: null };
const profile = (over: Partial<AdProfile> = {}): AdProfile => ({ ...(parseAdProfile(GOOD) as AdProfile), ...over });

test('an empty calculator is filled: colour, areas (main first), fee, and the stored logo copy; the bedrooms are remembered', () => {
  const plan = planProfileFill({ settings: EMPTY, edited: {}, last: {}, profile: profile(), logo: { kind: 'stored', url: 'https://ours.test/brand/a.png', sha256: 'h1' } });
  assert.deepEqual(plan.patch, { brandColour: '#1f4e79', areas: ['Leicester', 'Loughborough'], managementFeePct: 18, logoUrl: 'https://ours.test/brand/a.png' });
  assert.deepEqual(plan.pushed, { bedrooms: { min: 2, max: 4 }, brandColour: '#1f4e79', areas: ['Leicester', 'Loughborough'], feePct: 18, logoUrl: 'https://ours.test/brand/a.png', logoSha256: 'h1', logoCode: 'stored' });
  assert.equal(plan.dropLogo, null);
});

test('a field the customer edited is never overwritten, even when it still equals the last pushed value', () => {
  const settings = { logoUrl: 'https://ours.test/brand/mine.png', brandColour: '#222222', areas: ['Market Harborough'], managementFeePct: 12 };
  const last: ProfilePushed = { brandColour: '#222222', areas: ['Leicester'], feePct: 18, logoUrl: 'https://ours.test/brand/old.png' };
  const edited = { brandColour: '2026-11-30T09:00:00Z', areas: '2026-11-30T09:00:00Z', managementFeePct: '2026-11-30T09:00:00Z', logoUrl: '2026-11-30T09:00:00Z' };
  const plan = planProfileFill({ settings, edited, last, profile: profile(), logo: { kind: 'skipped' } });
  assert.deepEqual(plan.patch, {});
  assert.equal(plan.logoCode, 'edited');
  // What is remembered for an unwritten field is the earlier record.
  assert.equal(plan.pushed.brandColour, '#222222');
  assert.deepEqual(plan.pushed.areas, ['Leicester']);
  assert.equal(plan.pushed.feePct, 18);
});

test('a value still equal to the last pushed one is replaced by the new push; the customer’s own unmarked value stays', () => {
  const settings = { logoUrl: null, brandColour: '#111111', areas: ['Leicester'], managementFeePct: 15 };
  // Colour and areas were pushed before and are unchanged since; the fee 15 was never pushed (it is the customer's own).
  const last: ProfilePushed = { brandColour: '#111111', areas: ['Leicester'] };
  const plan = planProfileFill({ settings, edited: {}, last, profile: profile({ feePct: 18 }), logo: { kind: 'none' } });
  assert.deepEqual(plan.patch, { brandColour: '#1f4e79', areas: ['Leicester', 'Loughborough'] });
  assert.equal(plan.pushed.feePct, undefined, 'the fee was not written, so nothing is remembered as pushed for it');
});

test('a pushed null clears only a field that still holds the last pushed value; an empty field stays empty', () => {
  const settings = { logoUrl: 'https://ours.test/brand/a.png', brandColour: '#1f4e79', areas: ['Leicester'], managementFeePct: 18 };
  const last: ProfilePushed = { logoUrl: 'https://ours.test/brand/a.png', logoSha256: 'h1', brandColour: '#1f4e79', areas: ['Leicester'], feePct: 18 };
  const plan = planProfileFill({ settings, edited: {}, last, profile: profile({ logoUrl: null, brandColour: null, feePct: null, areas: [] }), logo: { kind: 'none' } });
  assert.deepEqual(plan.patch, { brandColour: null, areas: [], managementFeePct: null, logoUrl: null });
  assert.equal(plan.dropLogo, 'https://ours.test/brand/a.png', 'our old copy is deleted once the settings are saved');
  const empty = planProfileFill({ settings: EMPTY, edited: {}, last: {}, profile: profile({ logoUrl: null, brandColour: null, feePct: null, areas: [] }), logo: { kind: 'none' } });
  assert.deepEqual(empty.patch, {});
});

test('a dead or non-image logo: the calculator keeps the company name only, and the code is recorded (never the link)', () => {
  for (const code of ['fetch_failed', 'not_image', 'too_big', 'bad_url', 'store_failed'] as const) {
    const plan = planProfileFill({ settings: EMPTY, edited: {}, last: {}, profile: profile(), logo: { kind: 'failed', code } });
    assert.equal(plan.patch.logoUrl, undefined);
    assert.equal(plan.pushed.logoCode, code);
    assert.equal(plan.pushed.logoUrl, undefined);
    assert.ok(!JSON.stringify(plan.pushed).includes('store.example.test'), 'the signed link is never remembered');
  }
  // An earlier copy is kept rather than wiped by a dead link.
  const kept = planProfileFill({ settings: { ...EMPTY, logoUrl: 'https://ours.test/brand/a.png' }, edited: {}, last: { logoUrl: 'https://ours.test/brand/a.png' }, profile: profile(), logo: { kind: 'failed', code: 'fetch_failed' } });
  assert.equal(kept.patch.logoUrl, undefined);
  assert.equal(kept.dropLogo, null);
});

test('a new logo replacing our earlier copy drops the old copy; the same bytes change nothing', () => {
  const settings = { ...EMPTY, logoUrl: 'https://ours.test/brand/a.png' };
  const last: ProfilePushed = { logoUrl: 'https://ours.test/brand/a.png', logoSha256: 'h1' };
  const plan = planProfileFill({ settings, edited: {}, last, profile: profile(), logo: { kind: 'stored', url: 'https://ours.test/brand/b.png', sha256: 'h2' } });
  assert.equal(plan.patch.logoUrl, 'https://ours.test/brand/b.png');
  assert.equal(plan.dropLogo, 'https://ours.test/brand/a.png');
  const same = planProfileFill({ settings, edited: {}, last, profile: profile(), logo: { kind: 'unchanged', sha256: 'h1' } });
  assert.equal(same.patch.logoUrl, undefined);
  assert.equal(same.pushed.logoCode, 'unchanged');
});

test('areas and fee are shaped as the brand screen saves them', () => {
  assert.deepEqual(areasForSettings(['Leicester', 'leicester', 'Lenton, Nottingham', `${'y'.repeat(70)}`]), ['Leicester', 'Lenton Nottingham', 'y'.repeat(60)]);
  assert.equal(areasForSettings(Array.from({ length: 15 }, (_, i) => `Area ${i}`)).length, 12);
  assert.equal(feeForSettings(18.25), 18.3);
  assert.equal(feeForSettings(0), null, 'decision: a pushed 0 is no fee line');
  assert.equal(feeForSettings(null), null);
  assert.equal(feeForSettings(15), 15, 'a 15% fee is only ever the customer’s own (the lead database never sends Stayful’s)');
});

test('the brand screen marks only fields that really changed', () => {
  const before = { logoUrl: null, brandColour: '#1f4e79', areas: ['Leicester'], managementFeePct: 18 };
  assert.deepEqual(changedProfileFields(before, { brandColour: '#1F4E79', areas: ['Leicester'], managementFeePct: 18 }), []);
  assert.deepEqual(changedProfileFields(before, { brandColour: '#000000', areas: ['Leicester', 'Rugby'], managementFeePct: 20 }), ['brandColour', 'areas', 'managementFeePct']);
  assert.deepEqual(changedProfileFields(before, { logoUrl: 'https://ours.test/brand/x.png' }), ['logoUrl']);
  assert.deepEqual(markEdited({ areas: 'a' }, ['brandColour'], 'now'), { areas: 'a', brandColour: 'now' });
});

test('stored records are read tolerantly, and the pack prefers the lowest pushed bedroom count', () => {
  assert.deepEqual(parseProfilePushed(null), {});
  assert.deepEqual(parseSettingsEdited({ areas: '2026-11-30T09:00:00Z', companyName: 'x', brandColour: 3 }), { areas: '2026-11-30T09:00:00Z' });
  assert.equal(preferredBedrooms(parseProfilePushed({ bedrooms: { min: 2, max: 4 } })), 2);
  assert.equal(preferredBedrooms(parseProfilePushed({ bedrooms: { min: 5, max: 4 } })), null);
  assert.equal(preferredBedrooms(parseProfilePushed({ bedrooms: null })), null);
  assert.equal(preferredBedrooms(null), null);
});

test('source: the receiver and the server never log a link, an area, a colour or a fee', () => {
  for (const f of ['./ad-profile-server.ts', './ad-profile-run.ts', './ad-profile-logo.ts', './ad-profile.ts']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    for (const m of src.matchAll(/console\.(log|error|warn|info)\(([^\n]*)\);/g)) {
      const args = m[2].replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '');
      assert.doesNotMatch(args, /\b(url|logoUrl|profile|areas|brandColour|feePct|settings|pushed|bytes|body)\b/, `${f}: ${m[0]}`);
    }
    // Never writes leads.
    assert.doesNotMatch(src, /from\('leads'\)|crm_pushed_at/);
  }
});
