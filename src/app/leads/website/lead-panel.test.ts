import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reportStateText, websitePushRefusal, websiteCardModel, dueDayText } from '../../../lib/websites/lead-panel.ts';
import { REPORT_STATES } from '../../../lib/websites/types.ts';

/** Batch 31 phase 12: pins for the website lead view, the entry card and the manual push refusal. */
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const panel = strip(read('./LeadPanel.tsx'));
const leadPage = strip(read('../[id]/page.tsx'));
const listPage = strip(read('../page.tsx'));
const pushActions = strip(read('../integrations/actions.ts'));

test('LeadPanel reads only the allowed website_reports and lead_sources columns', () => {
  assert.match(panel, /REPORT_COLUMNS = "state, due_day, quality_ok, self_submit"/);
  assert.match(panel, /SOURCE_COLUMNS = "utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, ad_code, landing_page"/);
  // Both reads are by the lead the page already authorised, and nothing else is selected.
  assert.match(panel, /from\("website_reports"\)\.select\(REPORT_COLUMNS\)\.eq\("lead_id", leadId\)/);
  assert.match(panel, /from\("lead_sources"\)\.select\(SOURCE_COLUMNS\)\.eq\("lead_id", leadId\)/);
  assert.equal((panel.match(/\.select\(/g) ?? []).length, 2); // reports and sources only
});

test('LeadPanel never reads the result, the address or the leads table', () => {
  assert.doesNotMatch(panel, /from\("leads"\)/);
  assert.doesNotMatch(panel, /\bresult\b|\baddress\b|\bpostcode\b|AnalysisResult/);
  assert.doesNotMatch(panel, /billing_mode|price_pence|lease_until/);
});

test('the lead page adds exactly the panel, after its own owner-scoped read', () => {
  assert.match(leadPage, /import \{ LeadPanel \} from "\.\.\/website\/LeadPanel"/);
  assert.match(leadPage, /<LeadPanel leadId=\{lead\.id\} \/>/);
  assert.ok(leadPage.indexOf('.eq("user_id", scope.ownerId)') < leadPage.indexOf('<LeadPanel'), 'panel only after the scoped read');
  assert.match(leadPage, /if \(!data\) notFound\(\)/);
});

test('every report state has its own plain words, and the low-confidence and held wording is right', () => {
  const labels = new Set<string>();
  for (const state of REPORT_STATES) {
    const t = reportStateText({ state, dueDay: '2026-11-20', qualityOk: true });
    assert.ok(t.label && t.label !== 'Unknown', state);
    labels.add(t.label);
  }
  assert.equal(labels.size, REPORT_STATES.length);
  assert.equal(reportStateText({ state: 'awaiting_address', dueDay: null, qualityOk: null }).label, 'Awaiting address');
  assert.equal(reportStateText({ state: 'held_cap', dueDay: '2026-11-20', qualityOk: null }).label, 'Held until 20 Nov 2026');
  assert.equal(reportStateText({ state: 'held_credit', dueDay: null, qualityOk: null }).label, 'Waiting for credit');
  assert.match(reportStateText({ state: 'held_self', dueDay: null, qualityOk: null }).label, /self-submit/);
  assert.equal(reportStateText({ state: 'done', dueDay: null, qualityOk: true }).label, 'Done');
  assert.match(reportStateText({ state: 'done', dueDay: null, qualityOk: false }).label, /low confidence/i);
  assert.match(reportStateText({ state: 'done', dueDay: null, qualityOk: false }).label, /early estimate/);
  assert.match(reportStateText({ state: 'failed', dueDay: null, qualityOk: null }).detail, /will be in touch/);
  assert.equal(dueDayText('2026-11-20'), '20 Nov 2026');
  assert.equal(dueDayText(null), null);
});

test('manual push of a website lead is refused unless its report is done', () => {
  assert.equal(websitePushRefusal(null), null, 'an ordinary funnel lead has no report row');
  assert.equal(websitePushRefusal('done'), null);
  for (const s of REPORT_STATES.filter((x) => x !== 'done')) assert.match(websitePushRefusal(s) ?? '', /no completed report/, s);
  // Wired into the one manual push action, after its ownership and archive checks and before anything is sent.
  assert.match(pushActions, /from\('website_reports'\)\.select\('state'\)\.eq\('lead_id', leadId\)/);
  assert.match(pushActions, /websitePushRefusal\(/);
  const fn = pushActions.slice(pushActions.indexOf('export async function pushLeadAction'));
  assert.ok(fn.indexOf('websitePushRefusal(') > fn.indexOf('Restore this lead before sending it'));
  assert.ok(fn.indexOf('websitePushRefusal(') < fn.indexOf('enqueueDelivery('));
  // completeLead remains the only automatic route: this phase added no other delivery call.
  assert.equal((pushActions.match(/enqueueDelivery\(/g) ?? []).length, 1);
});

test('the /leads entry card shows only for an account owner who has a website, with no nav item', () => {
  assert.match(listPage, /const website = isOwner \? await ownWebsite\(scope\.ownerId\) : null/);
  assert.match(listPage, /\{website \? <WebsiteEntryCard site=\{website\} \/> : null\}/);
  assert.match(listPage, /from\("websites"\)\.select\("slug, status"\)\.eq\("user_id", ownerId\)/);
  assert.doesNotMatch(strip(read('../LeadsNav.tsx')), /website/i);
});

test('the card links to setup before go-live, the live address when live, and nowhere when paused', () => {
  for (const status of ['invited', 'setup', 'preview']) assert.equal(websiteCardModel({ slug: 'acme', status }).href, '/leads/setup/website', status);
  assert.equal(websiteCardModel({ slug: 'acme', status: 'live' }).href, '/s/acme');
  assert.equal(websiteCardModel({ slug: 'acme', status: 'paused' }).href, null);
  assert.equal(websiteCardModel({ slug: 'acme', status: 'live' }).statusLabel, 'Live');
  assert.match(strip(read('../../../lib/websites/lead-panel.ts')), /siteHref\(\{ slug: site\.slug \}\)/);
});
