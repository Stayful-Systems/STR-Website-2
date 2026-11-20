import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPushBody, buildTestBody, pdfSendable, reportBlock, MAX_PDF_BYTES } from './payload.ts';
import type { ReportSummary } from '../websites/summary.ts';

const pdf = (n = 100) => {
  const b = new Uint8Array(n);
  b.set([0x25, 0x50, 0x44, 0x46]);
  return b;
};
const summary = (over: Partial<ReportSummary['figures']> = {}): ReportSummary => ({
  kind: 'estimate',
  label: 'Estimate',
  figureLabels: {} as ReportSummary['figureLabels'],
  figures: { annualIncome: 42000, monthlyIncome: 3500, occupancyPct: 71, nightlyRate: 160, bedrooms: 3, ...over },
  early: false,
  caveat: null,
});

test('pdfSendable: needs %PDF, not empty, at most 3 MB', () => {
  assert.equal(pdfSendable(pdf()), true);
  assert.equal(pdfSendable(null), false);
  assert.equal(pdfSendable(new Uint8Array(0)), false);
  assert.equal(pdfSendable(new Uint8Array([1, 2, 3, 4, 5])), false);
  assert.equal(pdfSendable(pdf(MAX_PDF_BYTES)), true);
  assert.equal(pdfSendable(pdf(MAX_PDF_BYTES + 1)), false);
});

test('report block: occupancy is a percent 0-100, never a fraction', () => {
  const b = reportBlock(summary(), pdf());
  assert.ok(b);
  assert.equal(b.occupancy_pct, 71);
  assert.equal(b.gross_annual_income, 42000);
  assert.equal(b.nightly_rate, 160);
  assert.equal(b.bedrooms, 3);
  assert.equal(Buffer.from(b.pdf_base64, 'base64')[0], 0x25);
  assert.equal(reportBlock(summary({ occupancyPct: 150 }), pdf()), undefined);
  assert.equal(reportBlock(summary({ occupancyPct: -1 }), pdf()), undefined);
});

test('no report block without a summary or a sendable PDF', () => {
  assert.equal(reportBlock(null, pdf()), undefined);
  assert.equal(reportBlock(summary(), null), undefined);
  assert.equal(reportBlock(summary({ annualIncome: 0 }), pdf()), undefined);
});

test('the body is a closed field set with the SI lead id and the owner as member', () => {
  const b = buildPushBody({
    ownerId: 'owner-1',
    leadId: 'lead-1',
    lead: { name: ' Ann ', email: 'a@b.co', phone: '07700 900123', address: '1 High St', postcode: 'LS1 1AA', bedrooms: 3 },
  });
  assert.deepEqual(Object.keys(b).sort(), ['lead', 'si_lead_id', 'si_member_id']);
  assert.deepEqual(Object.keys(b.lead).sort(), ['address', 'bedrooms', 'email', 'message', 'name', 'phone', 'postcode']);
  assert.equal(b.lead.name, 'Ann');
  assert.equal(b.lead.bedrooms, '3');
  assert.equal(b.si_member_id, 'owner-1');
  assert.equal(b.si_lead_id, 'lead-1');
  const empty = buildPushBody({ ownerId: 'o', leadId: 'l', lead: { name: null, email: null, phone: null, address: null, postcode: null, bedrooms: null } });
  assert.equal(empty.lead.address, '');
  assert.equal(empty.lead.bedrooms, '');
});

test('the test body carries no landlord details', () => {
  const b = buildTestBody('o', 't');
  assert.equal(b.test, true);
  assert.ok(Object.values(b.lead).every((v) => v === ''));
});
