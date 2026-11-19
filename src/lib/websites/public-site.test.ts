import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Batch 31 phase 9: source pins for the public site (src/app/s/**) and the
 * landlord form. The routes need a database and a browser, so what is held
 * here is the shape of the code, in the repo's source-pin style.
 */
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
/** Source with comments removed, so a rule about code is not satisfied (or broken) by prose. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

const layout = code(read('../../app/s/[slug]/layout.tsx'));
const outer = code(read('../../app/s/layout.tsx'));
const home = code(read('../../app/s/[slug]/page.tsx'));
const fixed = code(read('../../app/s/[slug]/[page]/page.tsx'));
const area = code(read('../../app/s/[slug]/areas/[area]/page.tsx'));
const data = code(read('../../app/s/[slug]/site-data.ts'));
const render = code(read('./render.tsx'));
const form = code(read('./LeadForm.tsx'));
const pages = { home, fixed, area };

test('the site layout is neutral: operator title and icon, noindex, never Stayful', () => {
  assert.match(layout, /robots:\s*\{\s*index:\s*false,\s*follow:\s*false\s*\}/);
  assert.match(layout, /title:\s*name \|\| "Property income estimate"/);
  assert.match(layout, /icons:\s*logo \? \{ icon: logo \} : \{ icon: "\/icon-neutral\.svg" \}/);
  assert.match(layout, /companyName/);
  // The root layout's favicons and title are overridden, never named.
  assert.doesNotMatch(layout, /favicon|apple-icon|icon-light|icon-dark/);
  assert.doesNotMatch(layout, /stayful/i);
  // A paused site must 404 at once: no caching of the page behind a live address.
  assert.match(layout, /dynamic = "force-dynamic"/);
  // The brand reaches the page as CSS custom properties; attribution is mounted once here.
  assert.match(layout, /siteThemeVars\(/);
  assert.match(layout, /<AttributionProvider>/);
  assert.match(layout, /if \(!live\) notFound\(\)/);
});

test('the outer /s layout carries the same neutral frame for not-found pages', () => {
  assert.match(outer, /robots:\s*\{\s*index:\s*false,\s*follow:\s*false\s*\}/);
  assert.match(outer, /icons:\s*\{\s*icon:\s*"\/icon-neutral\.svg"\s*\}/);
  assert.doesNotMatch(outer, /stayful/i);
});

test('only a live site resolves: every page falls to notFound for anything else', () => {
  assert.match(data, /liveSiteBySlug\(slug\)/);
  assert.match(data, /if \(!row\) return null/);
  for (const [name, src] of Object.entries(pages)) {
    assert.match(src, /import \{ notFound \} from "next\/navigation"/, name);
    assert.match(src, /notFound\(\)/, name);
    assert.match(src, /loadLiveSite\(slug\)/, name);
    assert.match(src, /dynamic = "force-dynamic"/, name);
  }
  // Params are a promise (this Next version): awaited, never read synchronously.
  for (const [name, src] of Object.entries({ layout, ...pages })) assert.match(src, /await params/, name);
});

test('the fixed pages are fees, about, faq and privacy; anything else is a 404', () => {
  assert.match(fixed, /const PAGES = \["fees", "about", "faq", "privacy"\] as const/);
  assert.match(fixed, /if \(!isPage\(page\)\) notFound\(\)/);
  // An area page is looked up by its slug in the model; an unlisted area finds nothing.
  assert.match(area, /renderSitePage\(live\.pages, `areas\/\$\{area\}`\)/);
  assert.match(area, /if \(!body\) notFound\(\)/);
});

test('no page, layout or the render helper hard-codes /s/: every link goes through siteHref', () => {
  for (const [name, src] of Object.entries({ layout, outer, data, render, ...pages })) {
    assert.doesNotMatch(src, /["'`]\/s\//, `${name} spells /s/`);
    assert.doesNotMatch(src, /["'`]\/s["'`]/, `${name} spells /s`);
  }
  // The form works out the site's api base from the descriptor siteHref-built pages hand it.
  assert.doesNotMatch(form, /["'`]\/s\//);
  assert.match(form, /form\.action/);
  assert.match(form, /form\.privacyHref/);
});

test('the pages draw the shared templates with the real form, and the preview is the same components', () => {
  assert.match(render, /<SitePage page=\{page\} renderForm=\{leadFormRenderer\(opts\)\} \/>/);
  assert.match(render, /<LeadForm \{\.\.\.props\} preview=\{preview\} \/>/);
  assert.match(render, /buildSitePages\(/);
  assert.match(render, /pageAt\(/);
});

test('LeadForm keeps nothing in the browser: no storage, no cookies, no console, no address in a URL', () => {
  assert.match(read('./LeadForm.tsx'), /^"use client";/);
  assert.doesNotMatch(form, /localStorage|sessionStorage|indexedDB|document\.cookie|cookieStore/);
  assert.doesNotMatch(form, /console\./);
  // The address and the step token travel in a POST body only.
  assert.doesNotMatch(form, /history\.(push|replace)State|router\.(push|replace)|location\.(href|assign|replace)\s*=/);
  assert.match(form, /body:\s*JSON\.stringify\(\{\s*token: stepToken,\s*address: address\.trim\(\)/);
  assert.doesNotMatch(form, /\?token=|&token=|token=\$\{/);
  // Attribution is read once from the address into a context, as a path with no query string.
  assert.match(form, /createContext</);
  assert.match(form, /window\.location\.pathname/);
  assert.doesNotMatch(form, /landing:\s*window\.location\.(href|search)/);
});

test('LeadForm speaks the contract of the two form routes', () => {
  // Step 1: the descriptor's own action, the exact fields, the Turnstile token and the attribution.
  assert.match(form, /fetch\(form\.action,\s*\{\s*method: "POST"/);
  for (const k of ['name', 'email', 'phone', 'consent', 'turnstileToken', 'sources', 'landing']) assert.match(form, new RegExp(`\\b${k}\\b`), k);
  assert.match(form, /\{form\.consentText\}/);
  assert.match(form, /TurnstileWidget/);
  assert.match(form, /errors/);
  // Step 2: the report route, the autocomplete route with the site slug, the SSE stream.
  assert.match(form, /\$\{apiBase\}\/report/);
  assert.match(form, /\/api\/address-autocomplete\?q=.*&s=\$\{encodeURIComponent\(slug\)\}/);
  assert.match(form, /getReader\(\)/);
  assert.match(form, /event\.stage === "complete"/);
  for (const o of ['summary', 'summary_caveat', 'held', 'will_contact']) assert.match(form, new RegExp(o), o);
  // The token is component state, never forwarded anywhere but the report body.
  assert.match(form, /useState<string \| null>\(null\)/);
  assert.match(form, /within 24 hours/);
  assert.match(form, /"Estimate"|summary\.label/);
});

test('the attribution that reaches the form is the tags the server reads, trimmed (ad at most 40)', async () => {
  const ad = form.match(/const AD_MAX = (\d+)/);
  assert.equal(ad?.[1], '40');
  const keys = form.match(/const SOURCE_KEYS = \[([^\]]+)\]/)?.[1] ?? '';
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'ad']) assert.match(keys, new RegExp(`"${k}"`), k);
  // sources.ts is the server's side of the same list.
  const { parseSources } = await import(pathToFileURL(new URL('./sources.ts', import.meta.url).pathname).href);
  const s = parseSources({ utm_source: 'facebook', ad: 'x'.repeat(60) }, '/s/acme/fees?x=1');
  assert.equal(s.utm_source, 'facebook');
  assert.equal(s.ad_code?.length, 40);
  assert.equal(s.landing_page, '/s/acme/fees');
});
