import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GO_LIVE_DEDUPE, goLive, goLiveMessages, hasLeadForm, pageUrl, visibleText, type GoLiveDeps, type GoLiveEvent, type PageFetch } from './golive-server.ts';
import { buildSitePages, type SiteCopy } from './page-model.ts';
import { SAMPLE_COPY, SAMPLE_SETTINGS, SAMPLE_SITE } from './sample-site.ts';
import { siteUrl } from '../url.ts';

/**
 * Batch 31 phase 10: Approve's orchestration, run with a fake fetch and fake
 * status / activity effects (no server, no database).
 */

const BASE = 'https://app.example.test';
const FORM = '<form novalidate=""><input name="name" type="text"/><input name="email" type="email"/><input type="checkbox"/></form>';
const pageHtml = (body: string, withForm = true) => `<!DOCTYPE html><html><head><title>Northern Lets</title><script>self.__next_f.push([1,"{{ not visible }} undefined [object Object]"])</script></head><body><main><p>${body}</p>${withForm ? FORM : ''}</main></body></html>`;

interface Calls {
  fetched: string[];
  markLive: number;
  rollback: number;
  events: { kind: GoLiveEvent; dedupeKey: string }[];
}

function setup(over: { copy?: SiteCopy; fetchPage?: PageFetch; markLive?: boolean; rollback?: () => Promise<boolean>; pages?: 'none' } = {}) {
  const calls: Calls = { fetched: [], markLive: 0, rollback: 0, events: [] };
  const pages = over.pages === 'none' ? null : buildSitePages({ site: SAMPLE_SITE, settings: SAMPLE_SETTINGS, copy: over.copy ?? SAMPLE_COPY });
  const fetchPage: PageFetch =
    over.fetchPage ??
    (async (url) => {
      calls.fetched.push(url);
      return { status: 200, text: async () => pageHtml('Welcome', !url.endsWith('/privacy')) };
    });
  const deps: GoLiveDeps = {
    site: SAMPLE_SITE,
    settings: SAMPLE_SETTINGS,
    pages,
    baseUrl: BASE,
    fetchPage,
    markLive: async () => {
      calls.markLive++;
      return over.markLive ?? true;
    },
    rollback:
      over.rollback ??
      (async () => {
        calls.rollback++;
        return true;
      }),
    record: async (kind, opts) => {
      calls.events.push({ kind, dedupeKey: opts.dedupeKey });
    },
  };
  return { deps, calls };
}

/** A fetch that serves every page well except where `bad` answers differently. */
function fetchWith(calls: Calls, bad: (url: string) => { status?: number; html?: string; throws?: boolean } | null): PageFetch {
  return async (url) => {
    calls.fetched.push(url);
    const b = bad(url);
    if (b?.throws) throw new Error('network');
    return { status: b?.status ?? 200, text: async () => b?.html ?? pageHtml('Welcome', !url.endsWith('/privacy')) };
  };
}

test('passes when every public page is good: all seven fetched, status live, both events logged', async () => {
  const { deps, calls } = setup();
  const r = await goLive(deps);
  assert.equal(r.ok, true);
  assert.deepEqual(
    calls.fetched.sort(),
    ['', 'areas/leeds', 'areas/harrogate', 'fees', 'about', 'faq', 'privacy'].map((p) => pageUrl(BASE, SAMPLE_SITE, p)).sort(),
  );
  assert.ok(calls.fetched.includes(`${BASE}/s/northern-lets`));
  assert.ok(calls.fetched.includes(`${BASE}/s/northern-lets/areas/leeds`));
  assert.equal(calls.markLive, 1);
  assert.equal(calls.rollback, 0);
  assert.deepEqual(calls.events, [
    { kind: 'website_approved', dedupeKey: 'website_approved' },
    { kind: 'funnel_live', dedupeKey: 'website_live' },
  ]);
  assert.equal(GO_LIVE_DEDUPE.funnel_live, 'website_live');
  // The two keys differ: activity_events is unique on (user, dedupe_key) whatever the kind.
  assert.notEqual(GO_LIVE_DEDUPE.website_approved, GO_LIVE_DEDUPE.funnel_live);
});

test('the fetch base is the app helper (siteUrl) when none is passed, never a request Host', async () => {
  const { deps, calls } = setup();
  delete (deps as { baseUrl?: string }).baseUrl;
  await goLive(deps);
  assert.ok(calls.fetched.length > 0 && calls.fetched.every((u) => u.startsWith(siteUrl() + '/s/northern-lets')));
});

test('rolls back to preview when one page 404s, and names it', async () => {
  const { deps, calls } = setup();
  deps.fetchPage = fetchWith(calls, (u) => (u.endsWith('/areas/harrogate') ? { status: 404 } : null));
  const r = await goLive(deps);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.stage === 'pages');
  if (!r.ok && r.stage === 'pages') {
    assert.deepEqual(r.failures.map((f) => [f.path, f.reason]), [['areas/harrogate', 'status']]);
    assert.equal(r.rolledBack, true);
    assert.match(goLiveMessages(r).join('\n'), /harrogate area page returned 404/);
  }
  assert.equal(calls.rollback, 1);
  assert.deepEqual(calls.events, []);
});

test('rolls back when a page lacks the lead form, but the privacy page needs none', async () => {
  const { deps, calls } = setup();
  deps.fetchPage = fetchWith(calls, (u) => (u.endsWith('/fees') ? { html: pageHtml('Fees', false) } : null));
  const r = await goLive(deps);
  assert.ok(!r.ok && r.stage === 'pages');
  if (!r.ok && r.stage === 'pages') assert.deepEqual(r.failures.map((f) => [f.path, f.reason]), [['fees', 'no_form']]);
  assert.equal(calls.rollback, 1);
  assert.deepEqual(calls.events, []);
});

test('rolls back when a fetched page contains {{', async () => {
  const { deps, calls } = setup();
  deps.fetchPage = fetchWith(calls, (u) => (u.endsWith('/about') ? { html: pageHtml('Hello {{company}}') } : null));
  const r = await goLive(deps);
  assert.ok(!r.ok && r.stage === 'pages');
  if (!r.ok && r.stage === 'pages') assert.deepEqual(r.failures.map((f) => [f.path, f.reason]), [['about', 'placeholder']]);
  assert.equal(calls.rollback, 1);
  assert.deepEqual(calls.events, []);
});

test('a redirect is not a 200, and a fetch that throws is a failure too', async () => {
  const a = setup();
  a.deps.fetchPage = fetchWith(a.calls, (u) => (u.endsWith('/faq') ? { status: 302 } : null));
  const ra = await goLive(a.deps);
  assert.ok(!ra.ok && ra.stage === 'pages');
  if (!ra.ok && ra.stage === 'pages') assert.equal(ra.failures[0].detail, 'returned 302');

  const b = setup();
  b.deps.fetchPage = fetchWith(b.calls, (u) => (u.endsWith('/privacy') ? { throws: true } : null));
  const rb = await goLive(b.deps);
  assert.ok(!rb.ok && rb.stage === 'pages');
  if (!rb.ok && rb.stage === 'pages') assert.deepEqual(rb.failures.map((f) => [f.path, f.reason]), [['privacy', 'fetch']]);
  assert.equal(b.calls.rollback, 1);
});

test('every failing page is listed, and a rollback that fails is reported, not hidden', async () => {
  const { deps, calls } = setup({ rollback: async () => false });
  deps.fetchPage = fetchWith(calls, (u) => (u.endsWith('/fees') || u.endsWith('/about') ? { status: 500 } : null));
  const r = await goLive(deps);
  assert.ok(!r.ok && r.stage === 'pages');
  if (!r.ok && r.stage === 'pages') {
    assert.deepEqual(r.failures.map((f) => f.path).sort(), ['about', 'fees']);
    assert.equal(r.rolledBack, false);
    assert.match(goLiveMessages(r).join('\n'), /could not put your website back in preview/);
  }
});

test('blocked before going live when checkSite fails: a {{ in the copy never reaches the status or the fetch', async () => {
  const copy: SiteCopy = { ...SAMPLE_COPY, home: { ...SAMPLE_COPY.home, intro: 'Welcome to {{company}} lettings.' } };
  const { deps, calls } = setup({ copy });
  const r = await goLive(deps);
  assert.ok(!r.ok && r.stage === 'checks');
  if (!r.ok && r.stage === 'checks') {
    assert.ok(r.problems.some((p) => p.rule === 'placeholder' && p.page === 'home'));
    assert.match(goLiveMessages(r).join('\n'), /Leftover template tag/);
  }
  assert.equal(calls.markLive, 0);
  assert.equal(calls.rollback, 0);
  assert.deepEqual(calls.fetched, []);
  assert.deepEqual(calls.events, []);
});

test('blocked with no pages, and when the status would not move (nothing fetched, nothing to roll back)', async () => {
  const none = setup({ pages: 'none' });
  const r1 = await goLive(none.deps);
  assert.ok(!r1.ok && r1.stage === 'no_pages');
  assert.equal(none.calls.markLive, 0);

  const stuck = setup({ markLive: false });
  const r2 = await goLive(stuck.deps);
  assert.ok(!r2.ok && r2.stage === 'status');
  assert.deepEqual(stuck.calls.fetched, []);
  assert.equal(stuck.calls.rollback, 0);
});

test('a failed activity write does not undo a live site', async () => {
  const { deps } = setup();
  deps.record = async () => {
    throw new Error('log down');
  };
  const r = await goLive(deps);
  assert.equal(r.ok, true);
});

test('visibleText ignores script payloads, tags and comments; hasLeadForm reads the form', () => {
  const t = visibleText(pageHtml('Caf&eacute; &amp; more'));
  assert.ok(!/\{\{|undefined|object Object/.test(t));
  assert.match(t, /& more/);
  assert.equal(visibleText('<p>a</p><!-- {{x}} --><p>b&#39;s</p>'), "a b's");
  assert.equal(hasLeadForm(pageHtml('x')), true);
  assert.equal(hasLeadForm(pageHtml('x', false)), false);
});

// ── Source pins ──

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

test('golive-server logs activity only: no logConversion, no Meta conversions, no charge or tier import', () => {
  const s = code(src('./golive-server.ts'));
  assert.doesNotMatch(s, /logConversion|meta\/conversions/);
  assert.doesNotMatch(s, /funnels\/charge-server|funnels\/tiers/);
  assert.doesNotMatch(s, /server-only/);
  // The base URL comes from the app's helper, never the request.
  assert.match(s, /from '\.\.\/url\.ts'/);
  assert.match(s, /siteHref\(site, path\)/);
  assert.doesNotMatch(s, /headers\(\)|x-forwarded-host|\bhost\b.*request/i);
});
