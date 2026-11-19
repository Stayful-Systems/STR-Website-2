import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  landlordHeldEmail,
  landlordSummaryEmail,
  landlordWillContactEmail,
  operatorNewLeadEmail,
  operatorReportFailedEmail,
  type LandlordEmailBrand,
  type OperatorLeadInput,
} from './website.ts';
import { buildSummary, EARLY_ESTIMATE_CAVEAT } from '../websites/summary.ts';

const ADDRESS = '12 Acacia Avenue, Leeds LS6 1AB';
const result = { shortLet: { annualRevenue: 31250, occupancyRate: 0.71, averageDailyRate: 118.4 }, property: { bedrooms: 3 } } as Parameters<typeof buildSummary>[0];

const brand: LandlordEmailBrand = { company: 'Northern Lets', logoUrl: 'https://example.com/logo.png', primary: '#0a96a0', canReply: true };

const op: OperatorLeadInput = {
  company: 'Northern Lets',
  landlordName: 'Jane Smith',
  landlordEmail: 'jane@example.com',
  landlordPhone: '07700 900123',
  leadUrl: 'https://example.test/leads/abc',
  manageUrl: 'https://example.test/leads/setup/website',
};

const every = () => [
  landlordSummaryEmail({ brand, landlordName: 'Jane Smith', summary: buildSummary(result, true)! }),
  landlordSummaryEmail({ brand, landlordName: 'Jane Smith', summary: buildSummary(result, false)! }),
  landlordHeldEmail({ brand, landlordName: 'Jane Smith' }),
  landlordWillContactEmail({ brand, landlordName: 'Jane Smith' }),
  operatorNewLeadEmail(op),
  operatorReportFailedEmail(op),
];

test('no email carries an address or a link to the full report', () => {
  for (const e of every()) {
    for (const part of [e.subject, e.html, e.text]) {
      assert.ok(!part.includes(ADDRESS) && !/Acacia|LS6/.test(part));
      assert.doesNotMatch(part, /\/r\/|report_token|\/pdf/);
    }
  }
});

test('the summary shows the figures, labelled as estimates, in the operator brand', () => {
  const e = landlordSummaryEmail({ brand, landlordName: 'Jane Smith', summary: buildSummary(result, true)! });
  for (const s of ['£31,250', '£2,600', '71%', '£118', 'Estimated gross income per year', 'Hello Jane,', 'Northern Lets will be in touch', 'Any questions, just reply']) {
    assert.ok(e.text.includes(s), s);
    assert.ok(e.html.includes(s), s);
  }
  assert.equal(e.subject, 'Your short-let income estimate from Northern Lets');
  assert.ok(e.html.includes('https://example.com/logo.png'));
  assert.doesNotMatch(e.text, /Stayful/);
  assert.doesNotMatch(e.html, /Stayful/);
});

test('the caveat is present only when the report was low quality', () => {
  const good = landlordSummaryEmail({ brand, landlordName: null, summary: buildSummary(result, true)! });
  const low = landlordSummaryEmail({ brand, landlordName: null, summary: buildSummary(result, false)! });
  assert.ok(!good.text.includes(EARLY_ESTIMATE_CAVEAT) && !good.html.includes(EARLY_ESTIMATE_CAVEAT));
  assert.ok(low.text.includes(`Note: ${EARLY_ESTIMATE_CAVEAT}.`));
  assert.ok(low.html.includes(EARLY_ESTIMATE_CAVEAT));
  assert.ok(good.text.startsWith('Your short-let income estimate\n\nHello,'));
});

test('the held email is the 24-hour message and the will-contact email promises a call, with no figures', () => {
  const held = landlordHeldEmail({ brand, landlordName: 'Jane' });
  assert.match(held.text, /within 24 hours/);
  assert.match(held.text, /Northern Lets will also be in touch/);
  const will = landlordWillContactEmail({ brand, landlordName: 'Jane' });
  assert.match(will.text, /Northern Lets will be in touch/);
  for (const e of [held, will]) assert.doesNotMatch(e.text, /£|%/);
});

test('what a landlord or operator typed is escaped and cannot break a subject line', () => {
  const evil = '<script>x</script>\r\nBcc: a@b.c';
  const e1 = landlordSummaryEmail({ brand: { ...brand, company: evil }, landlordName: evil, summary: buildSummary(result, true)! });
  const e2 = landlordHeldEmail({ brand: { ...brand, company: evil }, landlordName: evil });
  const e3 = landlordWillContactEmail({ brand: { ...brand, company: evil }, landlordName: evil });
  const e4 = operatorNewLeadEmail({ ...op, landlordName: evil, landlordEmail: evil, landlordPhone: evil });
  const e5 = operatorReportFailedEmail({ ...op, landlordName: evil });
  for (const e of [e1, e2, e3, e4, e5]) {
    assert.ok(!e.html.includes('<script>'));
    assert.ok(!/[\r\n]/.test(e.subject));
  }
});

test('the operator emails carry step-1 details and the lead link only', () => {
  const n = operatorNewLeadEmail(op);
  assert.equal(n.subject, 'New landlord lead: Jane Smith');
  for (const s of ['Jane Smith', 'jane@example.com', '07700 900123', 'https://example.test/leads/abc', 'https://example.test/leads/setup/website']) {
    assert.ok(n.text.includes(s), s);
    assert.ok(n.html.includes(s), s);
  }
  assert.doesNotMatch(n.text, /£|estimate:/i);
  const f = operatorReportFailedEmail({ ...op, landlordPhone: null });
  assert.match(f.subject, /Please follow up: Jane Smith/);
  assert.doesNotMatch(f.text, /Phone:/);
  assert.match(f.text, /contact them directly/);
});

test('a missing or non-https logo falls back to the company name', () => {
  const e = landlordHeldEmail({ brand: { ...brand, logoUrl: 'http://example.com/l.png' }, landlordName: null });
  assert.ok(!e.html.includes('<img'));
  assert.ok(e.html.includes('<h2'));
  const noReply = landlordHeldEmail({ brand: { ...brand, canReply: false }, landlordName: null });
  assert.doesNotMatch(noReply.text, /just reply/);
});
