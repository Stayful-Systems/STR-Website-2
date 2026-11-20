import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Batch 33, Phase 6b: pins for the places a website's address is built or
 * advertised once the site can have its own domain. The behaviour of the
 * helpers themselves is in urls.test.ts.
 */
const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('the site layout is noindex on the temporary address and indexable only when the site has a (valid) domain', () => {
  const layout = read('app/s/[slug]/layout.tsx');
  assert.match(layout, /robots:\s*\{\s*index:\s*false,\s*follow:\s*false\s*\}/, 'noindex stays the default');
  assert.match(layout, /live && siteDomain\(live\.row\) \? \{ robots: \{ index: true, follow: true \} \} : \{\}/);
  assert.match(layout, /import \{ siteDomain \} from "@\/lib\/websites\/urls"/);
});

test('each public page names its canonical address, and only a site with a domain has one', () => {
  const site = read('app/s/[slug]/site-data.ts');
  assert.match(site, /return siteDomain\(site\) \? \{ canonical: siteAbsoluteUrl\(site, path\) \} : undefined;/);
  assert.match(read('app/s/[slug]/page.tsx'), /canonicalFor\(live\.row, ""\)/);
  assert.match(read('app/s/[slug]/[page]/page.tsx'), /canonicalFor\(live\.row, page\)/);
  assert.match(read('app/s/[slug]/areas/[area]/page.tsx'), /canonicalFor\(live\.row, `areas\/\$\{area\}`\)/);
});

test('the setup notice builds its address with siteAbsoluteUrl, not siteUrl(siteHref(...))', () => {
  const notice = read('app/leads/setup/website/Notice.tsx');
  assert.match(notice, /siteAbsoluteUrl\(site, ""\)/);
  assert.doesNotMatch(notice, /siteUrl\(siteHref/);
});

test('go-live checks the temporary address: it passes the slug only, never the site\'s domain', () => {
  const golive = read('lib/websites/golive-server.ts');
  assert.match(golive, /pageUrl\(base, \{ slug: deps\.site\.slug \}, page\.path\)/);
  assert.doesNotMatch(golive, /pageUrl\(base, deps\.site,/);
});

test('websites.domain is written only by the domain engine, when a domain goes live or is released', () => {
  // The seam that makes CUSTOM_DOMAINS_ON safe: no setup, approve or admin action sets a domain.
  for (const f of ['app/leads/setup/website/actions.ts', 'lib/websites/store-server.ts', 'lib/websites/golive-server.ts', 'lib/websites/admin-server.ts']) {
    assert.doesNotMatch(read(f), /\.update\(\{[^}]*\bdomain\b/, f);
  }
});
