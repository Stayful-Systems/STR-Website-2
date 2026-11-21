import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSitePages, type PageModel, type SiteSettings } from './page-model.ts';
import { SAMPLE_COPY, SAMPLE_SETTINGS } from './sample-site.ts';
import { parseAnalysisInput } from '../analysis/input.ts';
import {
  EXPORT_FORM_FIELDS,
  FORM_CSS,
  buildStaticSite,
  buildStaticSiteReport,
  listCssAssets,
  listPageAssets,
  pageFile,
  type StaticFiles,
  type StaticSiteInput,
} from './transfer-export.ts';

const LOGO = 'https://abcd.supabase.co/storage/v1/object/public/logos/northern.png';
const PHOTO = 'https://abcd.supabase.co/storage/v1/object/public/photos/team.jpg';
const SETTINGS: SiteSettings = { ...SAMPLE_SETTINGS, logoUrl: LOGO, photoUrl: PHOTO, aboutText: 'We started in a spare room.' };
const FORM_ACTION = 'https://app.example.test/api/t/0123456789abcdef0123456789abcdef/lead';
const APP_HOST = 'app.example.test';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const WOFF2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 4]);
const FAVICON_SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

const CSS_URL = '/_next/static/chunks/app.css?dpl=dpl_abc';
const CSS_TEXT = `@font-face{font-family:Inter;src:url(../media/inter-s.p.woff2) format("woff2")}
.hero{background:url("/_next/static/media/hero.png")}
.x{background:url(data:image/png;base64,AAAA)}
/*# sourceMappingURL=app.css.map */`;

const ASSETS: Record<string, Uint8Array> = {
  [LOGO]: PNG,
  [PHOTO]: JPG,
  '/_next/static/media/inter-s.p.woff2': WOFF2,
  '/_next/static/media/hero.png': PNG,
  '/favicon.svg': FAVICON_SVG,
};

const pagesFor = (slug: string, domain: string | null): PageModel[] =>
  buildSitePages({ site: { slug, domain }, settings: SETTINGS, copy: SAMPLE_COPY });

/** What the app really sends for a page, in the parts that matter: scripts, preloads, comments, Next ids, the form marker. */
function fixtureHtml(page: PageModel, opts: { canonical?: string } = {}): string {
  const link = (l: { href: string; label: string }) => `<a href="${l.href}">${l.label}</a>`;
  const sections = page.sections
    .map((s) => `<section id="${s.id}"><!-- -->${s.heading ? `<h2>${s.heading}</h2>` : ''}${s.paragraphs.map((p) => `<p>${p}</p>`).join('')}</section>`)
    .join('');
  return [
    '<!DOCTYPE html><html lang="en"><head>',
    '<meta charSet="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>',
    '<link rel="preload" href="/_next/static/media/inter-s.p.woff2" as="font" crossorigin="" type="font/woff2"/>',
    `<link rel="stylesheet" href="${CSS_URL}" data-precedence="next"/>`,
    '<link rel="preload" as="script" fetchPriority="low" href="/_next/static/chunks/main.js"/>',
    '<link rel="modulepreload" href="/_next/static/chunks/other.js"/>',
    '<script src="/_next/static/chunks/webpack.js" async=""></script>',
    `<title>${page.title}</title><meta name="description" content="Find out what your property could earn."/>`,
    '<meta name="robots" content="noindex, nofollow"/><meta name="next-size-adjust" content=""/>',
    opts.canonical ? `<link rel="canonical" href="${opts.canonical}"/>` : '',
    `<link rel="icon" href="${LOGO}"/><link rel="icon" href="/favicon.svg" type="image/svg+xml"/><link rel="apple-touch-icon" href="/apple-icon.png"/>`,
    '</head><body class="__variable_abc font-sans antialiased">',
    '<!--$--><div style="--background:#ffffff;--primary:#0a96a0;color-scheme:light" class="min-h-screen">',
    `<header><a href="${page.nav[0].href}" aria-label="Northern Lets: home"><img src="${LOGO}" alt="" class="h-10"/></a>`,
    `<nav>${page.nav.map(link).join('')}<details><summary>Areas</summary><ul>${page.areaLinks.map((l) => `<li>${link(l)}</li>`).join('')}</ul></details>${page.footer.map(link).join('')}</nav></header>`,
    `<main><h1>${page.heading}</h1>`,
    page.form ? `<a href="${page.href}#estimate" class="btn">${page.form.submitLabel}</a>` : '',
    sections,
    page.key === 'about' ? `<img src="${PHOTO}" alt="The Northern Lets team" class="w-full"/>` : '',
    page.form ? `<section id="estimate"><div data-transfer-form="${page.key}"></div></section>` : '',
    '</main><footer><a href="mailto:hello@northernlets.co.uk">hello@northernlets.co.uk</a><p>Powered by Stayful Intelligence</p></footer></div>',
    '<template id="B:0"></template><div hidden id="S:0"><p>suspended</p></div>',
    '<!--/$--><script>self.__next_f.push([1,"</div> NEXT_PUBLIC_SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY"])</script>',
    '<script id="__NEXT_DATA__" type="application/json">{}</script>',
    '</body></html>',
  ].join('');
}

function inputFor(slug: string, domain: string | null): StaticSiteInput {
  const pages = pagesFor(slug, domain);
  return {
    pages,
    htmlByPath: Object.fromEntries(pages.map((p) => [p.path, fixtureHtml(p, domain ? { canonical: `https://${domain}${p.href}` } : {})])),
    css: [{ url: CSS_URL, text: CSS_TEXT }],
    assets: ASSETS,
    formAction: FORM_ACTION,
    siteName: 'Northern Lets',
    domain,
  };
}

const htmlFiles = (files: StaticFiles): [string, string][] =>
  Object.entries(files).filter(([n]) => n.endsWith('.html')).map(([n, v]) => [n, v as string]);

const TEMP = inputFor('northern-lets', null);
const OWN = inputFor('northern-lets', 'northernlets.co.uk');

// ── Every page, nothing from the app ──

test('export: one .html per page, relative to the site root', () => {
  const files = buildStaticSite(TEMP);
  assert.deepEqual(
    TEMP.pages.map((p) => pageFile(p.path)),
    ['index.html', 'areas/leeds.html', 'areas/harrogate.html', 'fees.html', 'about.html', 'faq.html', 'privacy.html'],
  );
  for (const p of TEMP.pages) assert.equal(typeof files[pageFile(p.path)], 'string', p.path);
  for (const name of ['assets/site.css', 'assets/form.css']) assert.equal(typeof files[name], 'string', name);
  assert.equal(files['assets/form.css'], FORM_CSS);
});

for (const [label, input] of [
  ['temporary address', TEMP],
  ['own domain', OWN],
] as const) {
  test(`export (${label}): no script, no Next trace, no app address, no other slug, no secret names`, () => {
    const { files, problems } = buildStaticSiteReport(input);
    assert.deepEqual(problems, []);
    for (const [name, html] of htmlFiles(files)) {
      assert.doesNotMatch(html, /<script/i, name);
      assert.doesNotMatch(html, /<noscript|<style|<!--/i, name);
      assert.doesNotMatch(html, /\/_next\/|__next|__NEXT|data-precedence|rel="(preload|modulepreload)"/i, name);
      assert.doesNotMatch(html, /\/s\/northern-lets|\/api\/s\//, name);
      assert.doesNotMatch(html, /supabase|NEXT_PUBLIC|SERVICE_ROLE|INTERNAL_API_SECRET|process\.env/i, name);
      assert.doesNotMatch(html, /noindex|next-size-adjust|apple-icon|favicon\.svg|id="S:|id="B:/i, name);
      // The only mention of the app's host is the form's own action.
      const hosts = [...html.matchAll(/https?:\/\/[^/"'\s]+/g)].map((m) => m[0]);
      for (const h of hosts) {
        assert.ok(h.includes(APP_HOST) || h.includes('northernlets.co.uk') || h.includes('www.w3.org'), `${name}: ${h}`);
      }
      assert.equal(html.split(APP_HOST).length - 1, /<form/.test(html) ? 1 : 0, name);
    }
    for (const [name, text] of Object.entries(files)) {
      if (typeof text !== 'string') continue;
      assert.doesNotMatch(text, /\/_next\/|supabase|SERVICE_ROLE/i, name);
    }
  });

  test(`export (${label}): every internal link, image and stylesheet resolves to a file in the map`, () => {
    const files = buildStaticSite(input);
    let checked = 0;
    for (const [name, html] of htmlFiles(files)) {
      const dir = name.split('/').slice(0, -1);
      for (const m of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
        const ref = m[1];
        if (ref.startsWith('#') || /^(mailto|tel):/.test(ref) || /^https?:/.test(ref)) continue;
        assert.doesNotMatch(ref, /^\//, `${name}: ${ref} is not relative`);
        const parts = [...dir];
        for (const seg of ref.split('#')[0].split('/')) {
          if (seg === '..') parts.pop();
          else if (seg !== '.') parts.push(seg);
        }
        const target = parts.join('/');
        assert.ok(target in files, `${name}: ${ref} -> ${target}`);
        checked++;
      }
    }
    assert.ok(checked > 50);
  });

  test(`export (${label}): a page with a form has exactly one, posting to the transfer endpoint; privacy has none`, () => {
    const files = buildStaticSite(input);
    for (const p of input.pages) {
      const html = files[pageFile(p.path)] as string;
      const forms = html.match(/<form[\s>]/g) ?? [];
      assert.equal(forms.length, p.form ? 1 : 0, p.path);
      if (!p.form) continue;
      const tag = /<form[^>]*>/.exec(html)![0];
      assert.match(tag, /method="post"/);
      assert.ok(tag.includes(`action="${FORM_ACTION}"`), p.path);
      assert.match(FORM_ACTION, /\/api\/t\/[0-9a-f]{32}\/lead$/);
      assert.equal(html.includes('data-transfer-form'), false);
    }
    assert.equal((files['privacy.html'] as string).includes('<form'), false);
  });
}

// ── The form ──

test('export: the form carries exactly the fields the analysis reads, a consent box and a honeypot', () => {
  const html = buildStaticSite(TEMP)['index.html'] as string;
  const names = [...html.matchAll(/<(?:input|select)[^>]*\sname="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names, ['name', 'email', 'phone', 'address', 'postcode', 'bedrooms', 'guests', 'hp_company_site', 'consent']);
  assert.deepEqual(Object.values(EXPORT_FORM_FIELDS).sort(), [...names].sort());
  assert.match(html, /<input type="checkbox" name="consent" value="yes" required>/);
  assert.match(html, /<div class="tf-hp" aria-hidden="true">/);
  assert.match(html, /<option value="0">Studio<\/option>/);
  assert.match(html, /<option value="16">16<\/option>/);
  assert.match(html, /<a href="privacy\.html">Privacy &amp; Terms<\/a>/);
  assert.match(html, new RegExp(TEMP.pages[0].form!.consentText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // What a browser would post is accepted by the analysis parser.
  const body = { name: 'A', email: 'a@example.com', phone: '07700900000', address: '1 High Street', postcode: 'ls1 1aa', bedrooms: '2', guests: '4', consent: 'yes' };
  const parsed = parseAnalysisInput({ ...body, bedrooms: Number(body.bedrooms), guests: Number(body.guests) });
  assert.equal(parsed.ok, true);
});

test('export: the form text is escaped and the heading names the company', () => {
  const pages = pagesFor('northern-lets', null).map((p) => (p.form ? { ...p, form: { ...p.form, consentText: 'I agree <b>& "more"' }, site: { ...p.site, companyName: 'Smith & Sons' } } : p));
  const html = buildStaticSite({ ...TEMP, pages })['index.html'] as string;
  assert.match(html, /I agree &lt;b&gt;&amp; &quot;more&quot;/);
  assert.match(html, /Tell Smith &amp; Sons where to send it/);
});

// ── Nested pages ──

test('export: pages below the root reach the root with ../', () => {
  const files = buildStaticSite(TEMP);
  const leeds = files['areas/leeds.html'] as string;
  assert.match(leeds, /href="\.\.\/assets\/site\.css"/);
  assert.match(leeds, /href="\.\.\/assets\/form\.css"/);
  assert.match(leeds, /<a href="\.\.\/index\.html">Home<\/a>/);
  assert.match(leeds, /<a href="\.\.\/fees\.html">Fees<\/a>/);
  assert.match(leeds, /<a href="harrogate\.html">Harrogate<\/a>/);
  assert.match(leeds, /<a href="#estimate" class="btn">/, 'a jump to the form on the same page stays in the page');
  const home = files['index.html'] as string;
  assert.match(home, /href="assets\/site\.css"/);
  assert.match(home, /<a href="areas\/leeds\.html">Leeds<\/a>/);
  assert.match(home, /<a href="index\.html">Home<\/a>/);
  assert.match(home, /<a href="mailto:hello@northernlets\.co\.uk">/);
});

// ── Canonical, robots, icon ──

test('export: a canonical link is kept only on the site\'s own domain', () => {
  const temp = buildStaticSite({ ...TEMP, htmlByPath: { ...TEMP.htmlByPath, fees: fixtureHtml(TEMP.pages[3], { canonical: 'https://app.example.test/s/northern-lets/fees' }) } });
  for (const [name, html] of htmlFiles(temp)) assert.doesNotMatch(html, /rel="canonical"/, name);
  const own = buildStaticSite(OWN);
  assert.match(own['fees.html'] as string, /<link rel="canonical" href="https:\/\/northernlets\.co\.uk\/fees">/);
  assert.match(own['index.html'] as string, /<link rel="canonical" href="https:\/\/northernlets\.co\.uk\/">/);
  // A canonical on some other host is dropped even on a site with a domain.
  const wrong = buildStaticSite({ ...OWN, htmlByPath: { ...OWN.htmlByPath, fees: fixtureHtml(OWN.pages[3], { canonical: 'https://app.example.test/s/northern-lets/fees' }) } });
  assert.doesNotMatch(wrong['fees.html'] as string, /canonical/);
  // Absolute links to the site's own domain become relative too.
  const abs = buildStaticSite({ ...OWN, htmlByPath: { ...OWN.htmlByPath, faq: (OWN.htmlByPath.faq as string).replace('</main>', '<a href="https://northernlets.co.uk/fees#fee">fees</a></main>') } });
  assert.match(abs['faq.html'] as string, /<a href="fees\.html#fee">fees<\/a>/);
});

test('export: the logo becomes images/..., is the only icon, and the app\'s own icons are gone', () => {
  const files = buildStaticSite(TEMP);
  const home = files['index.html'] as string;
  assert.match(home, /<link rel="icon" href="images\/northern\.png">/);
  assert.match(home, /<img src="images\/northern\.png" alt="" class="h-10">/);
  assert.equal((home.match(/rel="icon"/g) ?? []).length, 1);
  assert.deepEqual(files['images/northern.png'], PNG);
  assert.match(files['about.html'] as string, /<img src="images\/team\.jpg" alt="The Northern Lets team" class="w-full">/);
  assert.deepEqual(files['images/team.jpg'], JPG);
  assert.equal('images/favicon.svg' in files, false);
  assert.match(files['areas/leeds.html'] as string, /<link rel="icon" href="\.\.\/images\/northern\.png">/);
});

// ── CSS and fonts ──

test('export: stylesheets become assets/site.css with fonts under assets/fonts and images under images', () => {
  const files = buildStaticSite(TEMP);
  const css = files['assets/site.css'] as string;
  assert.match(css, /url\("fonts\/inter-s\.p\.woff2"\)/);
  assert.match(css, /url\("\.\.\/images\/hero\.png"\)/);
  assert.match(css, /url\(data:image\/png;base64,AAAA\)/);
  assert.doesNotMatch(css, /_next|sourceMappingURL/);
  assert.deepEqual(files['assets/fonts/inter-s.p.woff2'], WOFF2);
  assert.deepEqual(files['images/hero.png'], PNG);
});

test('export: inline style blocks join the stylesheet, and the same sheet on every page is used once', () => {
  const withStyle = (html: string) => html.replace('</head>', '<style data-precedence="next" data-href="x">.inline{color:red}</style></head>');
  const htmlByPath = Object.fromEntries(Object.entries(TEMP.htmlByPath).map(([k, v]) => [k, withStyle(v)]));
  const css = buildStaticSite({ ...TEMP, htmlByPath })['assets/site.css'] as string;
  assert.equal(css.split('.inline{color:red}').length - 1, 1);
  assert.equal(css.split('@font-face').length - 1, 1);
});

test('export: two assets with the same file name get different names', () => {
  const other = 'https://cdn.example.test/other/northern.png';
  const input: StaticSiteInput = { ...TEMP, assets: { ...ASSETS, [other]: JPG } };
  const htmlByPath = { ...TEMP.htmlByPath, faq: (TEMP.htmlByPath.faq as string).replace('</main>', `<img src="${other}" alt="x"/></main>`) };
  const files = buildStaticSite({ ...input, htmlByPath });
  assert.deepEqual(files['images/northern.png'], PNG);
  assert.deepEqual(files['images/northern-2.png'], JPG);
  assert.match(files['faq.html'] as string, /<img src="images\/northern-2\.png" alt="x">/);
});

// ── What is not supplied ──

test('export: an image or font that was not supplied is dropped and reported, never linked to the app', () => {
  const { [LOGO]: _logo, '/_next/static/media/inter-s.p.woff2': _font, ...rest } = ASSETS;
  void _logo;
  void _font;
  const { files, problems } = buildStaticSiteReport({ ...TEMP, assets: rest });
  const home = files['index.html'] as string;
  assert.doesNotMatch(home, /<img|rel="icon"/);
  assert.match(files['assets/site.css'] as string, /url\("data:,"\)/);
  assert.ok(problems.some((p) => p.code === 'missing_asset' && p.ref === LOGO && p.page === ''));
  assert.ok(problems.some((p) => p.code === 'missing_asset' && p.ref?.endsWith('inter-s.p.woff2')));
  for (const [name, html] of htmlFiles(files)) assert.doesNotMatch(html, /supabase/, name);
});

test('export: a stylesheet that was not supplied is reported', () => {
  const { problems } = buildStaticSiteReport({ ...TEMP, css: [] });
  assert.ok(problems.some((p) => p.code === 'missing_stylesheet'));
});

test('export: an SVG with script is not shipped', () => {
  const evil = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const { files, problems } = buildStaticSiteReport({ ...TEMP, assets: { ...ASSETS, [LOGO]: evil } });
  assert.ok(problems.some((p) => p.code === 'unsafe_asset'));
  assert.equal(Object.keys(files).some((n) => n.endsWith('.svg')), false);
});

test('export: a link that is not a page of the site goes to the home page and is reported', () => {
  const html = (TEMP.htmlByPath.fees as string).replace('</main>', '<a href="/s/northern-lets/gone?x=1">gone</a><a href="/s/other-site/fees">other</a></main>');
  const { files, problems } = buildStaticSiteReport({ ...TEMP, htmlByPath: { ...TEMP.htmlByPath, fees: html } });
  assert.match(files['fees.html'] as string, /<a href="index\.html">gone<\/a><a href="index\.html">other<\/a>/);
  assert.equal(problems.filter((p) => p.code === 'unresolved_link').length, 2);
  assert.doesNotMatch(files['fees.html'] as string, /other-site/);
});

test('export: a page with a form model but no marker, or two markers, is reported', () => {
  const noMarker = (TEMP.htmlByPath.faq as string).replace(/<div data-transfer-form="[^"]*"><\/div>/, '');
  assert.ok(buildStaticSiteReport({ ...TEMP, htmlByPath: { ...TEMP.htmlByPath, faq: noMarker } }).problems.some((p) => p.code === 'missing_form' && p.page === 'faq'));
  const twice = (TEMP.htmlByPath.faq as string).replace('</main>', '<div data-transfer-form="faq"></div></main>');
  const r = buildStaticSiteReport({ ...TEMP, htmlByPath: { ...TEMP.htmlByPath, faq: twice } });
  assert.ok(r.problems.some((p) => p.code === 'extra_form'));
  assert.equal(((r.files['faq.html'] as string).match(/<form[\s>]/g) ?? []).length, 1);
});

test('export: a marker on a page with no form (privacy) draws nothing', () => {
  const html = (TEMP.htmlByPath.privacy as string).replace('</main>', '<div data-transfer-form="privacy"></div></main>');
  const r = buildStaticSiteReport({ ...TEMP, htmlByPath: { ...TEMP.htmlByPath, privacy: html } });
  assert.equal((r.files['privacy.html'] as string).includes('<form'), false);
});

test('export: a missing page, no pages and a bad form address throw', () => {
  const { privacy: _p, ...rest } = TEMP.htmlByPath;
  void _p;
  assert.throws(() => buildStaticSite({ ...TEMP, htmlByPath: rest }), /missing page privacy/);
  assert.throws(() => buildStaticSite({ ...TEMP, pages: [] }), /no pages/);
  for (const bad of ['', '/api/t/0123456789abcdef/lead', 'https://app.example.test/api/s/slug/lead', 'https://app.example.test/api/t/short/lead', 'javascript:alert(1)', `${FORM_ACTION}?x=1`, 'https://app.example.test/api/t/0123456789abcdef0123456789abcdef/lead"']) {
    assert.throws(() => buildStaticSite({ ...TEMP, formAction: bad }), /bad form address/, bad);
  }
});

// ── The tokenizer's corners ──

test('export: quoted ">" in an attribute, script text with tags, event handlers and javascript links', () => {
  const html = (TEMP.htmlByPath.faq as string).replace(
    '</main>',
    '<p title="a > b" onclick="steal()" data-nextjs-x="1">hi</p><a href="javascript:void(0)">x</a><button onClick="go()">b</button></main>',
  );
  const out = buildStaticSite({ ...TEMP, htmlByPath: { ...TEMP.htmlByPath, faq: html } })['faq.html'] as string;
  assert.match(out, /<p title="a > b">hi<\/p>/);
  assert.doesNotMatch(out, /onclick|onClick|javascript:|data-nextjs/i);
  assert.match(out, /<button>b<\/button>/);
  assert.doesNotMatch(out, /NEXT_PUBLIC|self\.__next/);
});

test('export: text, entities and svg self-closing tags survive', () => {
  const html = (TEMP.htmlByPath.faq as string).replace('</main>', '<p>Fish &amp; chips &#x27;n&#x27; more</p><svg viewBox="0 0 1 1"><path d="M0 0"/></svg></main>');
  const out = buildStaticSite({ ...TEMP, htmlByPath: { ...TEMP.htmlByPath, faq: html } })['faq.html'] as string;
  assert.match(out, /<p>Fish &amp; chips &#x27;n&#x27; more<\/p>/);
  assert.match(out, /<svg viewBox="0 0 1 1"><path d="M0 0" \/><\/svg>/);
  assert.match(out, /^<!doctype html><html lang="en"><head>/);
});

test('export: a page with no title gets the company name', () => {
  const html = (TEMP.htmlByPath.faq as string).replace(/<title>.*?<\/title>/, '');
  const out = buildStaticSite({ ...TEMP, htmlByPath: { ...TEMP.htmlByPath, faq: html } })['faq.html'] as string;
  assert.match(out, /<title>[^<]*\| Northern Lets<\/title>/);
});

test('listPageAssets and listCssAssets name what the caller must fetch', () => {
  const found = listPageAssets(TEMP.htmlByPath.about as string);
  assert.deepEqual(found.stylesheets, [CSS_URL]);
  assert.deepEqual(found.images, [LOGO, '/favicon.svg', PHOTO]);
  assert.deepEqual(listCssAssets(CSS_TEXT, CSS_URL), ['/_next/static/media/inter-s.p.woff2', '/_next/static/media/hero.png']);
  assert.deepEqual(listCssAssets('a{background:url(https://cdn.example.test/a.png)}', CSS_URL), ['https://cdn.example.test/a.png']);
});
