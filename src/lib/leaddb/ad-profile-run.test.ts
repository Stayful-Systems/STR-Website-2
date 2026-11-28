import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAdProfile, type AdProfile, type ProfilePushed, type SettingsEdited } from './ad-profile.ts';
import { fetchLogo, type FetchLike, type LogoFetch } from './ad-profile-logo.ts';
import { runApplyProfile, type ProfileDeps } from './ad-profile-run.ts';
import type { SiteSettings } from '../websites/page-model.ts';

/**
 * Batch 55 step 5 (Phase 1, 55c A1): a pushed profile applied to the calculator, end to end over fakes. The customer's
 * edited field is never overwritten, an empty field is filled, a field still holding the last pushed value is replaced,
 * a dead logo means the company name only, an older push is stale.
 */

const OWNER = '3f9a2c11-1111-4111-8111-111111111111';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const BASE: SiteSettings = {
  companyName: 'Harbour & Pine', logoUrl: null, brandColour: null, areas: [], managementFeePct: null,
  contactEmail: 'hello@harbour.test', contactPhone: '07123 456789', photoUrl: null, aboutText: null,
};

const profile = (over: Record<string, unknown> = {}): AdProfile => {
  const p = parseAdProfile({
    logoUrl: 'https://store.example.test/sign/logo.png?token=t1', brandColour: '#1F4E79', feePct: 18,
    areas: ['Leicester', 'Loughborough'], bedrooms: { min: 2, max: 4 }, profileAsOf: '2026-12-01T10:00:00.000Z', ...over,
  });
  assert.ok(p);
  return p;
};

interface World {
  account: { profileAsOf: Date | null; pushed: ProfilePushed } | null;
  site: { settings: SiteSettings; edited: SettingsEdited; funnelId: string; version: string } | null;
  logo: LogoFetch;
  storeFails: boolean;
  conflicts: number;
  calls: string[];
  stored: string[];
  deleted: string[];
  fetched: number;
}

function world(over: Partial<World> = {}): { w: World; deps: ProfileDeps } {
  const w: World = {
    account: { profileAsOf: null, pushed: {} },
    site: { settings: { ...BASE }, edited: {}, funnelId: 'f-1', version: 'v1' },
    logo: { ok: true, bytes: PNG, mime: 'image/png', sha256: 'sha-a' },
    storeFails: false, conflicts: 0, calls: [], stored: [], deleted: [], fetched: 0, ...over,
  };
  let seq = 0;
  const deps: ProfileDeps = {
    readAccount: async () => (w.account ? { ...w.account } : null),
    claim: async (_o, asOf) => {
      w.calls.push('claim');
      if (!w.account) return false;
      if (w.account.profileAsOf && w.account.profileAsOf.getTime() > Date.parse(asOf)) return false;
      w.account.profileAsOf = new Date(asOf);
      return true;
    },
    readSite: async () => (w.site ? structuredClone(w.site) : null),
    fetchLogo: async () => {
      w.fetched++;
      return w.logo;
    },
    storeLogo: async () => {
      if (w.storeFails) return null;
      const url = `https://ours.test/brand/${OWNER}/f-1/logo-${++seq}.png`;
      w.stored.push(url);
      return url;
    },
    writeSettings: async (_o, settings, version) => {
      w.calls.push('write');
      if (!w.site || version !== w.site.version) return 'conflict';
      if (w.conflicts > 0) {
        w.conflicts--;
        w.site.version = `${w.site.version}+`;
        return 'conflict';
      }
      w.site.settings = settings;
      w.site.version = `${version}.`;
      return 'ok';
    },
    deleteLogo: async (url) => {
      w.deleted.push(url);
    },
    writePushed: async (_o, _asOf, pushed) => {
      w.calls.push('pushed');
      if (w.account) w.account.pushed = pushed;
    },
  };
  return { w, deps };
}

test('a first push fills an empty calculator: logo (our own copy), colour, areas main first, fee; bedrooms remembered', async () => {
  const { w, deps } = world();
  const out = await runApplyProfile(deps, OWNER, profile());
  assert.equal(out.result, 'applied');
  const s = w.site!.settings;
  assert.equal(s.logoUrl, w.stored[0]);
  assert.ok(!s.logoUrl?.includes('store.example.test'), 'the signed link is never kept');
  assert.equal(s.brandColour, '#1f4e79');
  assert.deepEqual(s.areas, ['Leicester', 'Loughborough']);
  assert.equal(s.managementFeePct, 18);
  assert.equal(s.companyName, 'Harbour & Pine', 'the company and contact details are not touched');
  assert.deepEqual(w.account!.pushed.bedrooms, { min: 2, max: 4 });
  assert.equal(w.account!.pushed.logoCode, 'stored');
  assert.ok(!JSON.stringify(w.account!.pushed).includes('token='), 'the pushed record never holds the signed link');
});

test('an edited field is never overwritten; the others still follow the lead database', async () => {
  const { w, deps } = world();
  await runApplyProfile(deps, OWNER, profile());
  // The customer changes the colour and the fee on the brand screen (both marked edited).
  w.site!.settings = { ...w.site!.settings, brandColour: '#ff0000', managementFeePct: 10 };
  w.site!.edited = { brandColour: '2026-12-01T11:00:00Z', managementFeePct: '2026-12-01T11:00:00Z' };
  const out = await runApplyProfile(deps, OWNER, profile({ brandColour: '#00AA00', feePct: 22, areas: ['Rugby'], profileAsOf: '2026-12-02T10:00:00.000Z' }));
  assert.equal(out.result, 'applied');
  assert.equal(w.site!.settings.brandColour, '#ff0000');
  assert.equal(w.site!.settings.managementFeePct, 10);
  assert.deepEqual(w.site!.settings.areas, ['Rugby'], 'areas still held the last pushed value, so they are replaced');
});

test('an edited field stays even when the customer set it back to exactly the last pushed value', async () => {
  const { w, deps } = world();
  await runApplyProfile(deps, OWNER, profile());
  w.site!.edited = { areas: '2026-12-01T11:00:00Z' };
  await runApplyProfile(deps, OWNER, profile({ areas: ['Rugby'], profileAsOf: '2026-12-02T10:00:00.000Z' }));
  assert.deepEqual(w.site!.settings.areas, ['Leicester', 'Loughborough']);
});

test('a dead or non-image logo: company name only, the code recorded, nothing stored; the rest is still filled', async () => {
  for (const code of ['fetch_failed', 'not_image', 'too_big'] as const) {
    const { w, deps } = world({ logo: { ok: false, code } });
    const out = await runApplyProfile(deps, OWNER, profile());
    assert.equal(out.result, 'applied');
    assert.equal(out.logoCode, code);
    assert.equal(w.site!.settings.logoUrl, null);
    assert.equal(w.site!.settings.brandColour, '#1f4e79');
    assert.deepEqual(w.stored, []);
    assert.equal(w.account!.pushed.logoCode, code);
  }
  const { w, deps } = world({ storeFails: true });
  const out = await runApplyProfile(deps, OWNER, profile());
  assert.equal(out.logoCode, 'store_failed');
  assert.equal(w.site!.settings.logoUrl, null);
});

test('a real dead link and a non-image body go through fetchLogo to the same result', async () => {
  const dead: FetchLike = async () => new Response('gone', { status: 404 });
  const html: FetchLike = async () => new Response('<html>not a logo</html>', { status: 200, headers: { 'content-type': 'image/png' } });
  const throws: FetchLike = async () => {
    throw new Error('ECONNRESET https://store.example.test/sign/logo.png?token=t1');
  };
  for (const [f, code] of [[dead, 'fetch_failed'], [html, 'not_image'], [throws, 'fetch_failed']] as const) {
    const { w, deps } = world();
    deps.fetchLogo = (url) => fetchLogo(url, { fetch: f });
    const out = await runApplyProfile(deps, OWNER, profile());
    assert.equal(out.logoCode, code);
    assert.equal(w.site!.settings.logoUrl, null);
  }
});

test('the same logo pushed again is not stored twice; a customer’s own logo is never downloaded over', async () => {
  const { w, deps } = world();
  await runApplyProfile(deps, OWNER, profile());
  await runApplyProfile(deps, OWNER, profile({ profileAsOf: '2026-12-02T10:00:00.000Z', logoUrl: 'https://store.example.test/sign/logo.png?token=t2' }));
  assert.equal(w.stored.length, 1, 'same bytes: no second copy');
  assert.equal(w.account!.pushed.logoCode, 'unchanged');

  const mine = world();
  mine.w.site!.settings.logoUrl = 'https://ours.test/brand/their-own.png';
  mine.w.site!.edited = { logoUrl: '2026-11-30T09:00:00Z' };
  await runApplyProfile(mine.deps, OWNER, profile());
  assert.equal(mine.w.fetched, 0, 'an edited logo is never even downloaded');
  assert.equal(mine.w.site!.settings.logoUrl, 'https://ours.test/brand/their-own.png');
});

test('a new logo replaces our earlier copy, which is then deleted', async () => {
  const { w, deps } = world();
  await runApplyProfile(deps, OWNER, profile());
  const first = w.site!.settings.logoUrl;
  w.logo = { ok: true, bytes: PNG, mime: 'image/png', sha256: 'sha-b' };
  await runApplyProfile(deps, OWNER, profile({ profileAsOf: '2026-12-02T10:00:00.000Z' }));
  assert.notEqual(w.site!.settings.logoUrl, first);
  assert.deepEqual(w.deleted, [first]);
});

test('an older push is stale and changes nothing; an equal one is applied again; no account is no_account', async () => {
  const { w, deps } = world();
  await runApplyProfile(deps, OWNER, profile({ profileAsOf: '2026-12-02T10:00:00.000Z' }));
  const before = structuredClone(w.site!.settings);
  const old = await runApplyProfile(deps, OWNER, profile({ brandColour: '#000000', profileAsOf: '2026-12-01T10:00:00.000Z' }));
  assert.equal(old.result, 'stale');
  assert.deepEqual(w.site!.settings, before);
  assert.equal((await runApplyProfile(deps, OWNER, profile({ profileAsOf: '2026-12-02T10:00:00.000Z' }))).result, 'applied');
  const none = world({ account: null });
  assert.equal((await runApplyProfile(none.deps, OWNER, profile())).result, 'no_account');
  assert.deepEqual(none.w.calls, []);
});

test('a customer saving at the same moment: planned again from the fresh row, one logo copy at most', async () => {
  const { w, deps } = world({ conflicts: 1 });
  const out = await runApplyProfile(deps, OWNER, profile());
  assert.equal(out.result, 'applied');
  assert.equal(w.calls.filter((c) => c === 'write').length, 2);
  assert.equal(w.fetched, 1);
  assert.equal(w.stored.length, 1);
  assert.equal(w.site!.settings.brandColour, '#1f4e79');
  // Two conflicts in a row: nothing is written, the copy is taken back out, only the bedrooms are remembered.
  const busy = world({ conflicts: 5 });
  await runApplyProfile(busy.deps, OWNER, profile());
  assert.equal(busy.w.site!.settings.brandColour, null);
  assert.deepEqual(busy.w.deleted, busy.w.stored);
  assert.deepEqual(busy.w.account!.pushed, { bedrooms: { min: 2, max: 4 } });
});

test('no calculator site (none, or a normal website): nothing is filled, the bedrooms are still remembered', async () => {
  const { w, deps } = world({ site: null });
  const out = await runApplyProfile(deps, OWNER, profile());
  assert.equal(out.result, 'applied');
  assert.equal(w.fetched, 0);
  assert.deepEqual(w.account!.pushed, { bedrooms: { min: 2, max: 4 } });
});
