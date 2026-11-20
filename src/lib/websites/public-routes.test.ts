import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decideStep2, isSelfSubmit, landlordOutcome, nextState } from './policy.ts';
import { validateStepOne } from './checks.ts';
import { parseSources } from './sources.ts';

/**
 * Batch 31 phase 6: source pins for the two public form routes and the
 * autocomplete branch, in the repo's source-pin style (the routes need a
 * database, so what is held here is the shape of the code), plus the policy
 * facts the routes rely on.
 */
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
/** Source with comments removed, so a rule about code is not satisfied (or broken) by prose. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

const lead = code(read('../../app/api/s/[slug]/lead/route.ts'));
const report = code(read('../../app/api/s/[slug]/report/route.ts'));
const auto = read('../../app/api/address-autocomplete/route.ts');
const routes = { lead, report };

test('step 1 saves a lead even when step 2 never happens', () => {
  // The lead is captured, as a NEW lead, with no address, before and independent of any step 2.
  assert.match(lead, /captureLead\(\{/);
  assert.match(lead, /status:\s*'new'/);
  assert.match(lead, /property:\s*\{\s*address:\s*null,\s*postcode:\s*null,\s*bedrooms:\s*null\s*\}/);
  // It never reaches for the report run, nor anything that would move or remove the lead.
  assert.doesNotMatch(lead, /runWebsiteReport|report-server|completeLead|reserveAnalysis|runAnalysis/);
  assert.doesNotMatch(lead, /\.delete\(|\.update\(/);
  // The capture comes before the report row, and the token is the last thing, so nothing after the save can undo it.
  assert.ok(lead.indexOf('captureLead({') < lead.indexOf("from('website_reports')"));
  assert.ok(lead.indexOf("from('website_reports')") < lead.indexOf('issueStepToken('));
  // Policy: an abandoned report row only ever expires; it has no transition that touches a lead's status.
  assert.equal(nextState('awaiting_address', 'expired'), 'expired');
  assert.equal(landlordOutcome({ state: 'awaiting_address', quality: null, hasFigures: false }), 'will_contact');
});

test('the lead is not saved as queued, anywhere', () => {
  for (const [name, src] of Object.entries(routes)) {
    assert.doesNotMatch(src, /status:\s*'queued'|'queued'/, `${name} route`);
  }
});

test('neither route puts the result or the address in a response', () => {
  for (const [name, src] of Object.entries(routes)) {
    assert.doesNotMatch(src, /\bresult\b/i, `${name} route never touches a result`);
    assert.doesNotMatch(src, /AnalysisResult/, `${name} route`);
  }
  // Step 1 answers { ok, token } and errors; step 2 answers progress, outcome, message, summary.
  assert.match(lead, /reply\(\{ ok: true, token \}\)/);
  assert.match(lead, /reply\(\{ ok: true, token: null \}\)/);
  assert.match(report, /outcome: state\.outcome,\s*message,\s*summary: shown \? state\.summary : null/);
  // Nothing about the address, the contact details or the report state is sent back.
  const sent = [...report.matchAll(/(?:send|sseOnce)\(\{[^}]*\}/g)].map((m) => m[0]).join('\n');
  assert.doesNotMatch(sent, /address|postcode|email|phone|name:|input|dueDay|state:/i);
});

test('neither route imports funnel charging or tiers', () => {
  for (const [name, src] of Object.entries(routes)) {
    assert.doesNotMatch(src, /funnels\/charge-server|funnels\/tiers|tiers-server|from '@\/lib\/funnels'/, `${name} route`);
  }
});

test('step 1 counts the attempt against the website funnel; step 2 never does', () => {
  assert.match(lead, /countAttempt\(site\.funnelId, ip, dailyCap\)/);
  assert.match(lead, /\.eq\('kind', 'website'\)/);
  assert.doesNotMatch(report, /countAttempt|countAutocomplete|funnels\/caps|reserveSpend|settleSpend/);
});

test('step 1 guard order: live site, Turnstile, then the cap, then validation, then the lead', () => {
  const at = (needle: string) => {
    const i = lead.indexOf(needle);
    assert.ok(i >= 0, needle);
    return i;
  };
  assert.ok(at('liveSiteBySlug(slug)') < at('verifyTurnstile('));
  assert.ok(at('verifyTurnstile(') < at('countAttempt('));
  assert.ok(at('countAttempt(') < at('validateStepOne('));
  assert.ok(at('validateStepOne(') < at('captureLead({'));
  assert.match(lead, /if \(!site\) return new Response\('Not found', \{ status: 404 \}\)/);
  assert.match(report, /if \(!site\) return new Response\('Not found', \{ status: 404 \}\)/);
});

test('step 1 inserts are idempotent and consent comes from validateStepOne', () => {
  assert.match(lead, /from\('lead_sources'\)\.upsert\([^]*?ignoreDuplicates: true/);
  assert.match(lead, /from\('website_reports'\)[\s\S]*?\.upsert\([^]*?ignoreDuplicates: true/);
  assert.match(lead, /state: 'awaiting_address', self_submit: selfSubmit/);
  assert.match(lead, /parseSources\(/);
  assert.match(lead, /isSelfSubmit\(/);
  assert.match(lead, /notifyOperatorOfWebsiteLead\(/);
  // The same-hour dedupe window the funnel uses, applied by email because step 1 has no postcode.
  assert.match(lead, /reuseSince\(new Date\(\)\)/);
  // The token is issued only while the report is awaiting its address.
  assert.match(lead, /=== 'awaiting_address'/);
  assert.match(lead, /if \(!awaiting\) return reply\(\{ ok: true, token: null \}\)/);
});

test('step 2 verifies the token first, runs only from awaiting_address, and never twice', () => {
  const at = (needle: string) => {
    const i = report.indexOf(needle);
    assert.ok(i >= 0, needle);
    return i;
  };
  assert.ok(at('readStepToken(b.token)') < at('currentReportState('));
  assert.ok(at('claims.websiteId !== site.id') < at('currentReportState('));
  assert.ok(at("current.state !== 'awaiting_address'") < at('runWebsiteReport('));
  assert.ok(at("current.state !== 'awaiting_address'") < at(".from('leads')\n    .update("));
  assert.equal((report.match(/runWebsiteReport\(/g) ?? []).length, 1);
  // First writer wins on the address.
  assert.match(report, /\.is\('address', null\)/);
  // A landlord cannot reach a deal's report, a listing check or the PMI second opinion.
  assert.doesNotMatch(report, /fromDeal|checkedListingId|sourceListing|purchasePrice|advertisedRent/);
  assert.match(report, /enhancedRequested: false/);
});

test('step 2 sets maxDuration like the funnel analyse route', () => {
  assert.match(report, /export const maxDuration = 60;/);
  assert.match(read('../../app/api/f/[token]/analyse/route.ts'), /export const maxDuration = 60;/);
});

test('no console.log of the body, address, token or email; errors carry a name or code only', () => {
  for (const [name, src] of Object.entries(routes)) {
    assert.doesNotMatch(src, /console\.log|console\.info|console\.debug/, `${name} route`);
    for (const raw of src.split('\n').filter((l) => /console\.(error|warn)/.test(l))) {
      // An error NAME (err.name) or a Postgres error code is what may be logged.
      const line = raw.replace(/err instanceof Error \? err\.name : 'error'/, "'error'");
      assert.doesNotMatch(line, /\bbody\b|\bb\.|address|postcode|email|phone|token|\bname\b|\.message|String\(err\)|, err\)/i, `${name}: ${line.trim()}`);
    }
  }
  // The token is read from the body only: no URL, cookie or header.
  assert.doesNotMatch(report, /searchParams|cookies|headers\.get\(['"](?!x-forwarded)/);
  assert.doesNotMatch(lead, /searchParams|nextUrl/);
});

test('the autocomplete website branch: live sites only, house-paid, counted per IP, funnel branch unchanged', () => {
  assert.match(auto, /import \{ liveSiteBySlug \} from '@\/lib\/websites\/store-server';/);
  assert.match(auto, /const siteSlug = searchParams\.get\('s'\);/);
  const branch = auto.slice(auto.indexOf('} else if (siteSlug) {'), auto.indexOf('} else {\n    try {\n      const supabase'));
  assert.ok(branch.length > 100);
  assert.match(branch, /liveSiteBySlug\(siteSlug\)/);
  assert.match(branch, /if \(!site\) return Response\.json\(\{ suggestions: \[\] \}\)/);
  assert.match(branch, /countAutocomplete\(site\.funnelId, ip\)/);
  assert.doesNotMatch(branch, /userId =|requireCredit|fixedPrice|ownerPricing|reserveSpend/);
  // The funnel branch is untouched: still first, still keyed on `f`.
  assert.match(auto, /const funnelToken = searchParams\.get\('f'\);\n  const siteSlug[\s\S]*?if \(funnelToken\) \{\n    const funnel = await ownedFunnelByToken\(funnelToken\);/);
});

test('policy facts the routes rely on: step-1 validation, self-submit, attribution, billing frozen at step 2', () => {
  // Consent is required: without it nothing is written.
  const noConsent = validateStepOne({ name: 'Sam Lee', email: 'sam@example.co.uk', phone: '07700 900123', consent: false });
  assert.equal(noConsent.ok, false);
  assert.equal(validateStepOne({ name: 'Sam Lee', email: 'sam@example.co.uk', phone: '07700 900123', consent: true }).ok, true);
  // The operator testing their own site is flagged; a stranger is not.
  assert.equal(isSelfSubmit({ leadEmail: 'Owner@Example.com', ownerEmail: 'owner@example.com' }), true);
  assert.equal(isSelfSubmit({ leadEmail: 'sam@example.co.uk', ownerEmail: 'owner@example.com' }), false);
  // A free-mode self-submit is held, never run.
  const hold = decideStep2({ frozen: null, settings: { reportChargeOn: false, reportPence: 300 }, selfSubmit: true, balancePence: null });
  assert.equal(hold.kind, 'hold');
  // Attribution keeps a path, never a query string; the ad code is cut to 40.
  const s = parseSources({ utm_source: 'facebook', ad: 'x'.repeat(60) }, 'https://example.com/s/acme/fees?addr=1+High+St#top');
  assert.equal(s.landing_page, '/s/acme/fees');
  assert.equal(s.ad_code?.length, 40);
});

// ── Batch 33, Phase 7: the lead form on a customer's own domain ──

test('Turnstile is skipped only when the site\'s own domain is live, decided from the database; otherwise it runs as before', () => {
  assert.match(lead, /const ownDomainLive = await domainIsLiveFor\(site\.id, siteDomain\(site\)\);/);
  assert.match(lead, /if \(!ownDomainLive\) \{\s*const human = await verifyTurnstile\(typeof b\.turnstileToken === 'string' \? b\.turnstileToken : null, ip\);\s*if \(!human\.allow\) return reply\(\{ ok: false, error: human\.message \}, 403\);\s*\}/);
  // The only input to the decision is the site row and the database: never a field of the request.
  assert.doesNotMatch(lead.match(/const ownDomainLive = [^;]*;/)?.[0] ?? 'b.', /\bb\./);
  assert.doesNotMatch(lead, /request\.headers\.get\('(host|origin|referer)'\)/);
  // The live check is a database read of website_domains, in the domains store.
  const store = readFileSync(new URL('../domains/store-server.ts', import.meta.url), 'utf8');
  const fn = store.slice(store.indexOf('export async function domainIsLiveFor'));
  assert.match(fn, /from\('website_domains'\)[^;]*\.eq\('website_id', websiteId\)[^;]*\.eq\('name', name\)[^;]*\.eq\('status', 'live'\)/);
  assert.match(fn, /if \(error\) \{[^}]*return false;/, 'a failed read is not a skip');
});

test('the per-IP limit and the free-report caps still run on an own-domain site, and the honeypot comes before Turnstile and the caps', () => {
  assert.match(lead, /countAttempt\(site\.funnelId, ip, dailyCap\)/);
  const at = (needle: string) => {
    const i = lead.indexOf(needle);
    assert.ok(i >= 0, needle);
    return i;
  };
  assert.ok(at("typeof b.hp === 'string'") < at('domainIsLiveFor(') && at('domainIsLiveFor(') < at('verifyTurnstile(') && at('verifyTurnstile(') < at('countAttempt('));
  // The report route (step 2) never had Turnstile and still does not count: the free caps live in runWebsiteReport.
  assert.doesNotMatch(report, /turnstile/i);
});

test('a filled honeypot is a quiet success that saves nothing', () => {
  const guard = lead.slice(lead.indexOf("typeof b.hp === 'string'"), lead.indexOf('domainIsLiveFor('));
  assert.match(guard, /return reply\(\{ ok: true, token: null \}\);/);
  // Before any write: no lead, no source, no report row, no operator email can precede it.
  const before = lead.slice(0, lead.indexOf("typeof b.hp === 'string'"));
  assert.doesNotMatch(before, /captureLead\(\{|\.upsert\(|\.insert\(|notifyOperatorOfWebsiteLead\(/);
});

test('the lead form hides the bot-check widget on an own-domain site, and draws the hidden honeypot input and sends it', () => {
  const form = readFileSync(new URL('./LeadForm.tsx', import.meta.url), 'utf8');
  assert.match(form, /\{form\.skipBotCheck \? null : <TurnstileWidget /);
  assert.match(form, /name="hp_company_site"[^>]*tabIndex=\{-1\}[^>]*autoComplete="off"/);
  assert.match(form, /aria-hidden="true"/);
  assert.match(form, /hp: honeypot,/);
  const model = readFileSync(new URL('./page-model.ts', import.meta.url), 'utf8');
  assert.match(model, /\.\.\.\(siteDomain\(site\) \? \{ skipBotCheck: true \} : \{\}\),/);
});
