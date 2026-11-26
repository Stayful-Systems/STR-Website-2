import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { LeadDbAdAccount } from '../leaddb/ad-account.ts';
import {
  CALCULATOR_EDITABLE_FIELDS,
  CALCULATOR_MODE,
  CALCULATOR_PATHS,
  EMPTY_CALCULATOR_COPY,
  calculatorHasPath,
  calculatorServes,
  isCalculatorEditableField,
  isCalculatorMode,
  parseWebsiteMode,
} from './calculator.ts';
import { buildSitePages, type SiteSettings } from './page-model.ts';
import { freeSlug, makeSlug, slugProblem } from './slug.ts';

/** Batch 55 (Part A), phase A4: the calculator-only site. */
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

const NOW = new Date('2026-11-26T12:00:00Z');
const account = (over: Partial<LeadDbAdAccount> = {}): LeadDbAdAccount => ({
  ownerId: 'o1',
  ldCustomerId: 'c1',
  linkId: null,
  allowed: true,
  cardOnFile: true,
  accountStatus: 'active',
  cancelEffectiveAt: null,
  lapsed: false,
  stateAsOf: new Date('2026-11-25T00:00:00Z'),
  ...over,
});

const SETTINGS: SiteSettings = {
  companyName: 'Harbour & Co Lettings',
  logoUrl: null,
  brandColour: '#1e3a5f',
  areas: ['York', 'Leeds'],
  managementFeePct: 12,
  contactEmail: 'hello@harbour.example',
  contactPhone: '07700 900123',
  photoUrl: null,
  aboutText: null,
};

test('the mode is the word the database stores, and anything else is a normal site', () => {
  assert.equal(CALCULATOR_MODE, 'calculator');
  assert.equal(isCalculatorMode('calculator'), true);
  for (const other of ['site', '', null, undefined, 'Calculator', 7]) assert.equal(isCalculatorMode(other), false, String(other));
  assert.equal(parseWebsiteMode('calculator'), 'calculator');
  assert.equal(parseWebsiteMode('site'), 'site');
  assert.equal(parseWebsiteMode(null), 'site');
});

test('a normal site always serves, whatever its owner\'s ad account says', () => {
  assert.equal(calculatorServes({ mode: 'site' }, null, NOW), true);
  assert.equal(calculatorServes({ mode: 'site' }, account({ lapsed: true, cardOnFile: false }), NOW), true);
  assert.equal(calculatorServes({ mode: undefined }, null, NOW), true);
});

test('a calculator site serves while the account is in good standing', () => {
  assert.equal(calculatorServes({ mode: 'calculator' }, account(), NOW), true);
});

test('a calculator site is not served when the ad route is stopped', () => {
  const m = { mode: 'calculator' };
  assert.equal(calculatorServes(m, null, NOW), false, 'no account');
  assert.equal(calculatorServes(m, account({ stateAsOf: null }), NOW), false, 'no state ever pushed');
  assert.equal(calculatorServes(m, account({ lapsed: true }), NOW), false, 'lapsed');
  assert.equal(calculatorServes(m, account({ accountStatus: 'cancelled' }), NOW), false, 'cancelled');
  assert.equal(calculatorServes(m, account({ cardOnFile: false }), NOW), false, 'no card');
  assert.equal(calculatorServes(m, account({ cancelEffectiveAt: new Date('2026-11-26T00:00:00Z') }), NOW), false, 'cancel date reached');
});

test('a cancel date still in the future keeps serving', () => {
  assert.equal(calculatorServes({ mode: 'calculator' }, account({ accountStatus: 'pending_cancel', cancelEffectiveAt: new Date('2026-12-26T00:00:00Z') }), NOW), true);
});

test('a paused account still serves', () => {
  assert.equal(calculatorServes({ mode: 'calculator' }, account({ accountStatus: 'paused' }), NOW), true);
});

test('the editable fields are real settings keys: name, logo, colour, areas, fee, contact details; not photo or about', () => {
  assert.deepEqual([...CALCULATOR_EDITABLE_FIELDS], ['companyName', 'logoUrl', 'brandColour', 'areas', 'managementFeePct', 'contactEmail', 'contactPhone']);
  for (const key of CALCULATOR_EDITABLE_FIELDS) assert.ok(key in SETTINGS, key);
  assert.equal(isCalculatorEditableField('companyName'), true);
  assert.equal(isCalculatorEditableField('photoUrl'), false);
  assert.equal(isCalculatorEditableField('aboutText'), false);
});

test('the slug comes from the company name through makeSlug and freeSlug', () => {
  assert.equal(makeSlug('Harbour & Co Lettings'), 'harbour-and-co-lettings');
  assert.equal(freeSlug('Harbour & Co Lettings', new Set()), 'harbour-and-co-lettings');
  assert.equal(freeSlug('Harbour & Co Lettings', new Set(['harbour-and-co-lettings'])), 'harbour-and-co-lettings-2');
  assert.equal(freeSlug('Harbour & Co Lettings', ['harbour-and-co-lettings', 'harbour-and-co-lettings-2']), 'harbour-and-co-lettings-3');
  // A name that makes no address, or a reserved one, never becomes one by itself.
  assert.equal(freeSlug('!!!', new Set()), null);
  assert.equal(slugProblem(freeSlug('Admin', new Set())), null);
  assert.notEqual(freeSlug('Admin', new Set()), 'admin');
});

test('a calculator site draws its form and privacy page from the settings alone, with no page copy', () => {
  const pages = buildSitePages({ site: { slug: 'harbour' }, settings: SETTINGS, copy: EMPTY_CALCULATOR_COPY });
  const home = pages[0];
  assert.equal(home.path, '');
  assert.ok(home.form, 'the home page carries the lead form');
  assert.equal(home.form?.action, '/api/s/harbour/lead');
  assert.equal(home.site.companyName, 'Harbour & Co Lettings');
  assert.match(home.form?.consentText ?? '', /Harbour & Co Lettings/);
  const privacy = pages.find((p) => p.path === 'privacy');
  assert.ok(privacy, 'the consent tick has a privacy page to link to');
  assert.equal(calculatorHasPath(''), true);
  assert.equal(calculatorHasPath('privacy'), true);
  for (const closed of ['fees', 'about', 'faq', 'areas/york']) assert.equal(calculatorHasPath(closed), false, closed);
  assert.deepEqual([...CALCULATOR_PATHS], ['', 'privacy']);
});

test('the pure module imports nothing server-side', () => {
  const src = code(read('./calculator.ts'));
  assert.doesNotMatch(src, /server-only|supabase|next\//);
});

// ── Source pins: the pieces that need a database or Next ──

test('ensureCalculatorSite has exactly the signature the signed routes import and never throws', () => {
  const src = read('./store-server.ts');
  assert.match(
    src,
    /export async function ensureCalculatorSite\(input: \{ ownerId: string; company: string; email: string; phone: string \| null \}\): Promise<EnsureCalculatorSiteResult>/,
  );
  assert.match(src, /export type EnsureCalculatorSiteResult = \{ ok: true; slug: string; created: boolean \} \| \{ ok: false; reason: 'has_website' \| 'failed' \}/);
  const body = code(src.slice(src.indexOf('export async function ensureCalculatorSite')));
  const fn = body.slice(0, body.indexOf('// ── Setup flow writes'));
  assert.match(fn, /try \{/);
  assert.match(fn, /catch \(e\)/);
  // The row is live at once, in calculator mode, with live_at stamped, and no invite, copy, approval or domain.
  assert.match(fn, /status: 'live', mode: CALCULATOR_MODE/);
  assert.match(fn, /live_at: now/);
  assert.doesNotMatch(fn, /approved_at|pages:|domain/);
  assert.match(fn, /freeSlug\(/);
  assert.match(fn, /makeSlug\(/);
  // A normal website is refused, an existing calculator site is returned.
  assert.match(fn, /reason: 'has_website'/);
  assert.match(fn, /created: false/);
  // Logs carry a code only.
  for (const line of fn.split('\n').filter((l) => l.includes('console.error'))) assert.doesNotMatch(line, /company|email|phone|settings/i);
});

test('the website funnel stays kind=website and never active, for the calculator too', () => {
  const src = code(read('./store-server.ts'));
  assert.match(src, /kind: 'website', active: false/);
  assert.doesNotMatch(src, /active:\s*true/);
  assert.equal((src.match(/from\('funnels'\)/g) ?? []).length, 2);
});

test('the website row is read with its mode everywhere it is loaded', () => {
  const src = read('./store-server.ts');
  assert.match(src, /const COLUMNS = '[^']*\bdomain, mode'/);
  assert.match(src, /mode: parseWebsiteMode\(r\.mode\)/);
  assert.match(src, /mode: WebsiteMode;/);
});

test('the public lookup skips the pages check for calculator sites only, and stops the page when the route is stopped', () => {
  const src = code(read('../../app/s/[slug]/site-data.ts'));
  const load = src.slice(src.indexOf('export const loadLiveSite'), src.indexOf('export function canonicalFor'));
  assert.match(load, /isCalculatorMode\(row\.mode\)/);
  assert.match(load, /readAdAccount\(row\.userId\)/);
  assert.match(load, /calculatorServes\(row, account, new Date\(\)\)/);
  // The pages check for a normal site is unchanged and comes after the calculator branch.
  assert.match(load, /const pages = sitePagesOf\(row, row\.settings, row\.pages\);\s*if \(!pages\) return null;/);
  assert.ok(load.indexOf('isCalculatorMode') < load.indexOf('sitePagesOf('));
});

test('a calculator stop closes the page only: the lead and report paths and the report cron never call the page lookup', () => {
  const lookup = /loadLiveSite/;
  for (const rel of ['../../app/api/s/[slug]/report/route.ts', './report-server.ts', '../../app/api/internal/website-reports/route.ts']) {
    assert.doesNotMatch(read(rel), lookup, rel);
  }
  // The store's own lookup is not changed by the stop rule (the page lookup is the only place it is read).
  assert.doesNotMatch(read('./store-server.ts'), /adRouteStopped|calculatorServes|readAdAccount/);
});

test('the home page of a calculator site is only the branded form; the other pages are a 404', () => {
  const home = code(read('../../app/s/[slug]/page.tsx'));
  assert.match(home, /isCalculatorMode\(live\.row\.mode\) \? renderCalculatorPage\(live\.pages, ""\) : renderSitePage\(live\.pages, ""\)/);
  const fixed = code(read('../../app/s/[slug]/[page]/page.tsx'));
  assert.match(fixed, /if \(calculator && page !== "privacy"\) notFound\(\)/);
  const area = code(read('../../app/s/[slug]/areas/[area]/page.tsx'));
  assert.match(area, /if \(!live \|\| isCalculatorMode\(live\.row\.mode\)\) notFound\(\)/);
});

test('the calculator frame has no navigation and no page copy', () => {
  const src = code(read('./templates/CalculatorPage.tsx'));
  assert.doesNotMatch(src, /<nav|<Nav\b|areaLinks|page\.nav|page\.sections|page\.intro|page\.heading/);
  assert.match(src, /renderForm\(\{/);
});
