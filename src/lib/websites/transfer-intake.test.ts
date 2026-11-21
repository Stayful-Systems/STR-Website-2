import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AnalysisInput } from '../analysis/input.ts';
import {
  EXPORTED_LANDING,
  INTAKE_OUTCOMES,
  backOrigin,
  consentTicked,
  inputColumns,
  outcomeOf,
  takeExportedLead,
  thanksCopy,
  type IntakeCapture,
  type IntakeDeps,
  type IntakeResult,
  type IntakeTarget,
} from './transfer-intake.ts';
import type { LeadSourceFields } from './types.ts';

/**
 * Batch 37 phase 6: the exported form's intake, with counting fakes for every
 * outside call (the repo's injected-deps style), plus source pins for the route.
 */
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

const REF = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OWNER = '11111111-1111-4111-8111-111111111111';
const FUNNEL = '22222222-2222-4222-8222-222222222222';
const SITE = '33333333-3333-4333-8333-333333333333';
const PAID = { plan: 'pro', plan_source: 'manual' };
const FREE = { plan: 'free' };

// Private values that must never reach a log line.
const EMAIL = 'alex.landlord@gmail.com';
const NAME = 'Alex Landlord';
const PHONE = '07700 900123';
const ADDRESS = '12 Private Street, Leeds';

const goodForm = (over: Record<string, string> = {}): Record<string, string> => ({
  name: NAME,
  email: EMAIL,
  phone: PHONE,
  consent: 'on',
  address: ADDRESS,
  postcode: 'LS1 4AB',
  bedrooms: '2',
  guests: '4',
  ...over,
});

interface FakeLead {
  id: string;
  email: string;
  address: string | null;
  postcode: string | null;
  bedrooms: number | null;
  status: string;
  input: AnalysisInput | null;
  createdAt: number;
}

class World {
  leads: FakeLead[] = [];
  sources = new Map<string, LeadSourceFields>();
  reports = new Map<string, { websiteId: string; selfSubmit: boolean; state: string }>();
  captures: IntakeCapture[] = [];
  pushes: string[] = [];
  notifies: string[] = [];
  runs: string[] = [];
  attempts: { funnelId: string; ip: string; dailyCap: number }[] = [];
  logs: string[] = [];
  loads = 0;
  /** What the transfer lookup finds: the site's status never enters into it. */
  siteStatus = 'live';
  cancelled = false;
  missing = false;
  profile: Record<string, unknown> | null = PAID;
  ownerEmail: string | null = 'owner@operator.example';
  captureFails = false;
  dailyCap: number | null = 100;
  ipLimit = 5;
  private perIp = new Map<string, number>();
  clock = Date.parse('2026-11-21T12:00:00Z');

  deps(): IntakeDeps {
    return {
      now: () => new Date(this.clock),
      loadTransfer: async (): Promise<IntakeTarget | null> => {
        this.loads++;
        if (this.missing) return null;
        return { transferId: 't1', cancelled: this.cancelled, site: { id: SITE, userId: OWNER, funnelId: FUNNEL, contactEmail: 'hello@operator.example', contactPhone: '01132 000000' } };
      },
      dailyCapOf: async () => this.dailyCap,
      countAttempt: async (funnelId, ip, dailyCap) => {
        this.attempts.push({ funnelId, ip, dailyCap });
        const n = (this.perIp.get(ip) ?? 0) + 1;
        this.perIp.set(ip, n);
        return n > this.ipLimit ? 'ip_throttle' : 'ok';
      },
      recentLeadId: async ({ email, since }) => this.leads.find((l) => l.email === email && l.createdAt >= Date.parse(since))?.id ?? null,
      captureLead: async (input) => {
        if (this.captureFails) return null;
        this.captures.push(input);
        const lead: FakeLead = {
          id: `lead-${this.leads.length + 1}`,
          email: input.contact.email,
          address: input.property.address,
          postcode: input.property.postcode,
          bedrooms: input.property.bedrooms,
          status: input.status,
          input: null,
          createdAt: this.clock,
        };
        this.leads.push(lead);
        return { id: lead.id };
      },
      saveSources: async (leadId, sources) => void (this.sources.has(leadId) || this.sources.set(leadId, sources)),
      ownerContact: async () => ({ email: this.ownerEmail, phone: null }),
      saveReportRow: async ({ leadId, websiteId, selfSubmit }) => void (this.reports.has(leadId) || this.reports.set(leadId, { websiteId, selfSubmit, state: 'awaiting_address' })),
      reportState: async (leadId) => this.reports.get(leadId)?.state ?? null,
      enqueueLeadDbPush: async (leadId) => void this.pushes.push(leadId),
      notifyOperator: async ({ leadId }) => void this.notifies.push(leadId),
      ownerProfile: async () => this.profile,
      saveInput: async ({ leadId, input }) => {
        const lead = this.leads.find((l) => l.id === leadId);
        if (!lead || lead.input) return false;
        lead.input = input;
        return true;
      },
      runReportLater: (leadId) => void this.runs.push(leadId),
      log: (line) => void this.logs.push(line),
    };
  }

  post(form: Record<string, string>, ip = '203.0.113.7', ref = REF): Promise<IntakeResult> {
    return takeExportedLead({ ref, ip, form }, this.deps());
  }
}

const outcome = (r: IntakeResult) => (r.kind === 'done' ? r.outcome : r.kind);

test('a form-encoded post creates a lead and pushes it to the lead database', async () => {
  const w = new World();
  const r = await w.post(goodForm());
  assert.equal(r.kind, 'done');
  assert.equal(w.leads.length, 1);
  assert.deepEqual(w.pushes, ['lead-1']);
  assert.deepEqual(w.notifies, ['lead-1']);
  // A New lead, with the address and postcode on the lead's own columns, owned by the site's owner.
  const c = w.captures[0];
  assert.equal(c.status, 'new');
  assert.equal(c.userId, OWNER);
  assert.equal(c.funnelId, FUNNEL);
  assert.equal(c.property.address, ADDRESS);
  assert.equal(c.property.postcode, 'LS1 4AB');
  assert.equal(c.property.bedrooms, 2);
  assert.equal(c.contact.email, EMAIL);
  // Attribution says where it came from, and the report row waits for its address.
  assert.equal(w.sources.get('lead-1')?.landing_page, EXPORTED_LANDING);
  assert.equal(w.reports.get('lead-1')?.state, 'awaiting_address');
  assert.equal(w.reports.get('lead-1')?.websiteId, SITE);
  // The caps were counted against the site's own funnel with the funnel's daily cap and the visitor's IP.
  assert.deepEqual(w.attempts, [{ funnelId: FUNNEL, ip: '203.0.113.7', dailyCap: 100 }]);
});

test('the lead database push is called after the lead and its report row exist', async () => {
  const w = new World();
  const d = w.deps();
  const seen: string[] = [];
  const push = d.enqueueLeadDbPush;
  d.enqueueLeadDbPush = async (id) => {
    seen.push(w.reports.has(id) ? 'report-row-first' : 'no-report-row');
    return push(id);
  };
  await takeExportedLead({ ref: REF, ip: '203.0.113.7', form: goodForm() }, d);
  assert.deepEqual(seen, ['report-row-first']);
});

test('a lead database push that rejects never fails the post', async () => {
  const w = new World();
  const d = w.deps();
  d.enqueueLeadDbPush = () => Promise.reject(new Error('down'));
  const r = await takeExportedLead({ ref: REF, ip: '1.1.1.1', form: goodForm() }, d);
  assert.equal(outcome(r), 'report');
});

test('no plan: the lead is captured and pushed, no input is saved, no report runs', async () => {
  for (const profile of [FREE, { plan: 'free', stripe_subscription_status: 'canceled' }, null]) {
    const w = new World();
    w.profile = profile;
    const r = await w.post(goodForm());
    assert.equal(outcome(r), 'contact');
    assert.equal(w.leads.length, 1);
    assert.equal(w.leads[0].input, null, 'no input means no report can ever run');
    assert.equal(w.runs.length, 0);
    assert.deepEqual(w.pushes, ['lead-1']);
    assert.deepEqual(w.notifies, ['lead-1']);
  }
});

test('a paid plan with a usable address saves the input and runs the report once', async () => {
  const w = new World();
  const r = await w.post(goodForm());
  assert.equal(outcome(r), 'report');
  assert.deepEqual(w.runs, ['lead-1']);
  const input = w.leads[0].input;
  assert.ok(input);
  assert.equal(input.property.address, ADDRESS);
  assert.equal(input.property.postcode, 'LS1 4AB');
  assert.equal(input.email, EMAIL);
  assert.equal(input.enhancedRequested, false);
  assert.equal(input.fromDeal, false);
  // The same enquiry again inside the hour is the same lead and never a second run.
  w.clock += 5 * 60_000;
  const again = await w.post(goodForm());
  assert.equal(outcome(again), 'contact');
  assert.equal(w.leads.length, 1);
  assert.equal(w.runs.length, 1);
});

test('a paid plan with an unusable address keeps the lead, saves no input and runs nothing', async () => {
  for (const over of [{ address: '' }, { postcode: 'x' }, { bedrooms: '' }, { guests: '40' }] as Record<string, string>[]) {
    const w = new World();
    const r = await w.post(goodForm(over));
    assert.equal(outcome(r), 'contact', JSON.stringify(over));
    assert.equal(w.leads.length, 1);
    assert.equal(w.leads[0].input, null);
    assert.equal(w.runs.length, 0);
  }
});

test('a visitor cannot reach a deal report, prices or the second opinion through the form', async () => {
  const w = new World();
  await w.post(goodForm({ fromDeal: 'true', purchasePrice: '1', advertisedRent: '1', checkedListingId: 'x', enhancedRequested: 'true' }));
  const input = w.leads[0].input;
  assert.ok(input);
  assert.equal(input.fromDeal, false);
  assert.equal(input.askingPrice, null);
  assert.equal(input.rentPcm, null);
  assert.equal(input.checkedListingId, null);
  assert.equal(input.enhancedRequested, false);
});

test('the honeypot saves nothing, counts nothing, and answers like a thank-you', async () => {
  for (const field of ['hp', 'hp_company_site']) {
    const w = new World();
    const r = await w.post(goodForm({ [field]: 'http://spam.example' }));
    assert.equal(outcome(r), 'contact');
    assert.equal(w.leads.length, 0);
    assert.equal(w.attempts.length, 0);
    assert.equal(w.sources.size, 0);
    assert.equal(w.reports.size, 0);
    assert.deepEqual(w.pushes, []);
    assert.deepEqual(w.notifies, []);
    assert.deepEqual(w.runs, []);
  }
  // An empty honeypot is a person.
  const w = new World();
  assert.equal(outcome(await w.post(goodForm({ hp_company_site: '   ' }))), 'report');
});

test('the sixth post in ten minutes from one address is refused and saves nothing', async () => {
  const w = new World();
  for (let i = 1; i <= 5; i++) {
    const r = await w.post(goodForm({ email: `person${i}@gmail.com` }));
    assert.notEqual(outcome(r), 'wait', `post ${i}`);
  }
  assert.equal(w.leads.length, 5);
  const sixth = await w.post(goodForm({ email: 'person6@gmail.com' }));
  assert.equal(outcome(sixth), 'wait');
  assert.equal(w.leads.length, 5);
  assert.equal(w.pushes.length, 5);
  assert.equal(w.runs.length, 5);
  // Another address is not held up by the first one's count.
  assert.notEqual(outcome(await w.post(goodForm({ email: 'person7@gmail.com' }), '198.51.100.9')), 'wait');
});

test('the funnel daily cap and an unreadable cap both refuse without saving', async () => {
  const w = new World();
  const d = w.deps();
  d.countAttempt = async () => 'daily_cap';
  assert.equal(outcome(await takeExportedLead({ ref: REF, ip: '1.1.1.1', form: goodForm() }, d)), 'wait');
  d.countAttempt = async () => 'unavailable';
  assert.equal(outcome(await takeExportedLead({ ref: REF, ip: '1.1.1.1', form: goodForm() }, d)), 'wait');
  w.dailyCap = null;
  assert.equal(outcome(await w.post(goodForm())), 'wait');
  assert.equal(w.leads.length, 0);
});

test('details that fail validation are refused with nothing saved', async () => {
  const bad: Record<string, string>[] = [
    goodForm({ name: 'A' }),
    goodForm({ email: 'not-an-email' }),
    goodForm({ phone: '12345' }),
    (() => {
      const f = goodForm();
      delete f.consent;
      return f;
    })(),
    goodForm({ consent: 'off' }),
  ];
  for (const form of bad) {
    const w = new World();
    assert.equal(outcome(await w.post(form)), 'check');
    assert.equal(w.leads.length, 0);
    assert.equal(w.reports.size, 0);
    assert.deepEqual(w.pushes, []);
  }
});

test('the order: caps are counted before validation, validation before anything is saved', async () => {
  const w = new World();
  await w.post(goodForm({ email: 'nope' }));
  assert.equal(w.attempts.length, 1, 'a refused post still counts against the IP');
  assert.equal(w.captures.length, 0);
});

test('it still works after the site is paused and the overlap has ended', async () => {
  const w = new World();
  w.siteStatus = 'paused';
  const r = await w.post(goodForm());
  assert.equal(outcome(r), 'report');
  assert.equal(w.leads.length, 1);
  assert.deepEqual(w.pushes, ['lead-1']);
});

test('a cancelled transfer refuses; an unknown reference is not found', async () => {
  const w = new World();
  w.cancelled = true;
  assert.equal(outcome(await w.post(goodForm())), 'check');
  assert.equal(w.leads.length, 0);
  assert.equal(w.attempts.length, 0);
  w.cancelled = false;
  w.missing = true;
  assert.equal(outcome(await w.post(goodForm())), 'not_found');
  assert.equal(w.leads.length, 0);
});

test('an owner testing their own form is flagged as a self-submit', async () => {
  const w = new World();
  w.ownerEmail = EMAIL;
  await w.post(goodForm());
  assert.equal(w.reports.get('lead-1')?.selfSubmit, true);
  const other = new World();
  await other.post(goodForm());
  assert.equal(other.reports.get('lead-1')?.selfSubmit, false);
});

test('a lead that cannot be saved says so and nothing else happens', async () => {
  const w = new World();
  w.captureFails = true;
  assert.equal(outcome(await w.post(goodForm())), 'wait');
  assert.equal(w.reports.size, 0);
  assert.deepEqual(w.pushes, []);
  assert.deepEqual(w.notifies, []);
});

test('no log line carries the form: ids and codes only', async () => {
  const w = new World();
  await w.post(goodForm());
  await w.post(goodForm({ email: 'second@gmail.com' }));
  await w.post(goodForm({ email: 'bad' }));
  await w.post(goodForm({ hp: 'bot' }));
  w.captureFails = true;
  await w.post(goodForm({ email: 'third@gmail.com' }));
  w.captureFails = false;
  w.deps().saveInput = async () => false;
  const d = w.deps();
  d.saveInput = async () => false;
  await takeExportedLead({ ref: REF, ip: '9.9.9.9', form: goodForm({ email: 'fourth@gmail.com' }) }, d);
  assert.ok(w.logs.length > 0, 'the failure paths do log');
  const all = w.logs.join('\n');
  for (const secret of [EMAIL, NAME, PHONE, ADDRESS, 'LS1 4AB', 'gmail.com', REF, 'spam']) assert.ok(!all.includes(secret), `log carries ${secret}`);
});

test('consent as a form sends it, outcomes, thank-you words and the back link', () => {
  for (const yes of ['on', 'true', '1', 'yes', 'ON', ' on ']) assert.equal(consentTicked(yes), true, yes);
  for (const no of ['', 'off', 'false', '0', undefined, 5, null]) assert.equal(consentTicked(no), false, String(no));

  assert.deepEqual([...INTAKE_OUTCOMES], ['report', 'contact', 'check', 'wait']);
  assert.equal(outcomeOf('report'), 'report');
  assert.equal(outcomeOf(['wait', 'report']), 'wait');
  assert.equal(outcomeOf('nonsense'), 'contact');
  assert.equal(outcomeOf(undefined), 'contact');

  assert.equal(thanksCopy('report', 'Acme Lets').body, 'Your income report is on its way by email.');
  assert.equal(thanksCopy('contact', 'Acme Lets').body, 'Acme Lets will be in touch.');
  assert.equal(thanksCopy('contact', '  ').body, 'We will be in touch.');
  assert.match(thanksCopy('check', 'Acme').heading, /go back and check/i);
  assert.match(thanksCopy('wait', 'Acme').body, /go back and try again/i);
  for (const o of INTAKE_OUTCOMES) assert.doesNotMatch(JSON.stringify(thanksCopy(o, 'Acme')), /stayful/i);

  assert.equal(backOrigin('https://acme-lets.co.uk/contact?x=1#top'), 'https://acme-lets.co.uk');
  assert.equal(backOrigin('http://localhost:3000/form'), 'http://localhost:3000');
  for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://x.example/', 'not a url', '', null, undefined]) assert.equal(backOrigin(bad), null, String(bad));
});

test('inputColumns is the live report route\'s update, and writes no status', () => {
  const cols = inputColumns({ property: { address: 'A', postcode: 'LS1 4AB', bedrooms: 2 } } as unknown as AnalysisInput);
  assert.deepEqual(Object.keys(cols).sort(), ['address', 'bedrooms', 'input', 'postcode', 'postcode_area']);
});

// ── Source pins ──

const intake = code(read('./transfer-intake.ts'));
const route = code(read('../../app/api/t/[ref]/lead/route.ts'));
const thanks = code(read('../../app/t/[ref]/thanks/page.tsx'));

test('neither the intake nor the route writes leads.status or leads.crm_pushed_at, or charges', () => {
  for (const [name, src] of Object.entries({ intake, route, thanks })) {
    assert.doesNotMatch(src, /crm_pushed_at/, name);
    assert.doesNotMatch(src, /'queued'|status:\s*'(sent|contacted|held|done)'/, name);
    assert.doesNotMatch(src, /charge-server|funnels\/tiers|\.rpc\(|reserveSpend|settleSpend|completeLead|reserveAnalysis/, name);
  }
  // The one status the intake names is New, and the only lead write in the route is the input columns.
  assert.deepEqual([...new Set([...intake.matchAll(/status:\s*'([a-z_]+)'/g)].map((m) => m[1]))], ['new']);
  assert.doesNotMatch(intake, /\.update\(|\.insert\(|\.delete\(/);
  assert.deepEqual([...route.matchAll(/from\('leads'\)\s*\.update\(([^)]*\)?)\)/g)].map((m) => m[1]), ['inputColumns(input)']);
});

test('the route takes a plain form post: no JSON, no Turnstile, no CORS, a 303 to the thank-you page', () => {
  assert.match(route, /application\/x-www-form-urlencoded/);
  assert.match(route, /status:\s*303/);
  assert.match(route, /\/t\/\$\{ref\}\/thanks\?r=\$\{outcome\}/);
  assert.doesNotMatch(route, /request\.json|turnstile|Access-Control|OPTIONS/i);
  assert.match(route, /takeExportedLead\(/);
  assert.match(route, /after\(async/);
});

test('the route does not care whether the site is live or the overlap has ended', () => {
  assert.doesNotMatch(route, /liveSiteBySlug|\.eq\('status'|overlap_ended_at|overlap_ends_at|domainIsLiveFor|siteDomain/);
  // It refuses only a cancelled transfer (cancelled_at), through intake.
  assert.match(route, /cancelled_at/);
  assert.match(route, /from\('websites'\)\.select\('id, user_id, funnel_id, settings'\)/);
});

test('the route logs ids and error names, never a body', () => {
  const lines = [...route.matchAll(/console\.error\(([^;]*)\);/g)].map((m) => m[1]);
  assert.ok(lines.length >= 4);
  for (const l of lines) {
    assert.doesNotMatch(l, /\bform\b|\bbody\b|email|address|phone|name:|request|raw/i, l);
    assert.match(l, /^['`]\[transfer-lead\]|^line$/, l);
  }
  assert.doesNotMatch(route, /console\.(log|info|warn)\(/);
  assert.doesNotMatch(intake, /console\./);
});

test('the thank-you page is noindex, reads the snapshot, and links back only through backOrigin', () => {
  assert.match(thanks, /robots:\s*\{\s*index:\s*false/);
  assert.match(thanks, /snapshot/);
  assert.match(thanks, /backOrigin\(/);
  assert.match(thanks, /dynamic\s*=\s*"force-dynamic"/);
  // It shows nothing about the lead.
  assert.doesNotMatch(thanks, /from\("leads"\)|from\("lead_sources"\)/);
});
