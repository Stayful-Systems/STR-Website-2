import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isSwitchedOff, switchedOffBySlug, type SwitchedOffLookup } from './grace-public.ts';

const read = (rel: string) => readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8');
const OFF = { switched_off_at: '2026-03-01T06:47:00Z', cancelled_at: null };

test('a paused site with a switch-off that was not undone is switched off, deleted or not', () => {
  assert.equal(isSwitchedOff('paused', OFF), true);
  assert.equal(isSwitchedOff('paused', { ...OFF }), true, 'the stub row left after deletion still counts');
});

test('a site an admin paused (no switch-off), a live one and a switched-back-on one are not switched off', () => {
  assert.equal(isSwitchedOff('paused', null), false);
  assert.equal(isSwitchedOff('paused', { switched_off_at: null, cancelled_at: null }), false);
  assert.equal(isSwitchedOff('live', OFF), false);
  assert.equal(isSwitchedOff('paused', { ...OFF, cancelled_at: '2026-04-01T09:00:00Z' }), false);
  for (const status of ['invited', 'setup', 'preview', undefined, null]) assert.equal(isSwitchedOff(status, OFF), false, String(status));
});

test('switchedOffBySlug asks only for a valid slug, and any failure reads as false (a 404, as before)', async () => {
  const calls: string[] = [];
  const lookup: SwitchedOffLookup = async (slug) => {
    calls.push(slug);
    return slug === 'gone-site' ? { status: 'paused', grace: OFF } : slug === 'held-site' ? { status: 'paused', grace: null } : null;
  };
  assert.equal(await switchedOffBySlug('gone-site', lookup), true);
  assert.equal(await switchedOffBySlug('held-site', lookup), false);
  assert.equal(await switchedOffBySlug('unknown-site', lookup), false);
  assert.equal(await switchedOffBySlug('Bad Slug!', lookup), false);
  assert.equal(await switchedOffBySlug('../etc', lookup), false);
  assert.equal(await switchedOffBySlug('x', lookup), false);
  assert.deepEqual(calls, ['gone-site', 'held-site', 'unknown-site'], 'a bad slug never reaches the lookup');
  assert.equal(await switchedOffBySlug('gone-site', async () => { throw new Error('db down'); }), false);
});

test('the neutral page holds no settings values: no company, logo, colour, contact, form or Stayful branding', () => {
  const src = read('src/lib/websites/templates/SwitchedOff.tsx');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(code, /This site is no longer available/);
  assert.doesNotMatch(code, /settings|companyName|logoUrl|brandColour|contactEmail|contactPhone|photoUrl|aboutText|siteThemeVars|SiteShell/);
  assert.doesNotMatch(code, /<form|<input|<img|<a\b|<Link|href=/);
  assert.doesNotMatch(code, /Stayful|Powered by|var\(--primary/i);
  assert.doesNotMatch(code, /^import /m, 'it imports nothing: no data can reach it');
});

test('the layout shows the neutral page only for a switched-off site, noindex with a neutral title, and still 404s anything else', () => {
  const src = read('src/app/s/[slug]/layout.tsx');
  assert.match(src, /if \(await switchedOffBySlug\(slug\)\) return <SwitchedOff \/>;\s*\n\s*notFound\(\);/);
  assert.match(src, /if \(!live && \(await switchedOffBySlug\(slug\)\)\) return \{ title: SWITCHED_OFF_TITLE, robots: \{ index: false, follow: false \}/);
  // The metadata for it never reads the operator's name or logo.
  const meta = src.slice(src.indexOf('export async function generateMetadata'), src.indexOf('export default async function SiteLayout'));
  const neutral = meta.slice(meta.indexOf('if (!live && (await switchedOffBySlug'), meta.indexOf('const name'));
  assert.doesNotMatch(neutral, /companyName|logoUrl/);
});

test('the lead and report APIs still refuse a switched-off site: they only accept a live one', () => {
  const store = read('src/lib/websites/store-server.ts');
  assert.match(store, /export async function liveSiteBySlug[\s\S]*?\.eq\('status', 'live'\)/);
  for (const f of ['src/app/api/s/[slug]/lead/route.ts', 'src/app/api/s/[slug]/report/route.ts']) {
    let src = '';
    try {
      src = read(f);
    } catch {
      continue;
    }
    assert.match(src, /liveSiteBySlug/, f);
    assert.doesNotMatch(src, /grace-public|switchedOff|isSwitchedOff/, `${f} must not learn about switch-off: it only accepts a live site`);
  }
  assert.doesNotMatch(read('src/lib/websites/report-server.ts'), /grace-public/);
});

test('own-domain routing: a switched-off site reaches /s/<slug>, an admin-paused one does not', () => {
  const src = read('src/lib/domains/host-server.ts');
  assert.match(src, /\.in\('websites\.status', \['live', 'paused'\]\)/);
  assert.match(src, /site\.status === 'live' \|\| isSwitchedOff\(String\(site\.status\), grace\)/);
  assert.match(src, /website_grace\(switched_off_at, cancelled_at\)/);
  // The temporary-address redirect still needs a live site.
  assert.match(src, /\.eq\('slug', slug\)\.eq\('status', 'live'\)\.eq\('website_domains\.status', 'live'\)/);
});
