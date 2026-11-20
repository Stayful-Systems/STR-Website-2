/**
 * What goes to the lead database for one website lead (Batch 32).
 *
 * A closed field set, copied one by one: nothing else on the lead row or the
 * analysis (listing links, comparables, the funnel, the report token) can
 * reach the output. The address goes into the operator's own lead on the other
 * side and nowhere else; it is never logged.
 *
 * Occupancy is a PERCENT from 0 to 100 (the Batch 31 §31.4 trap: the analyser
 * stores 0-1, `buildSummary` already converts it, so this reads the summary's
 * figure rather than converting a second time).
 *
 * Pure: no network, no database, no server-only.
 */
import type { ReportSummary } from '../websites/summary.ts';
import type { WebsiteLeadBody } from './client.ts';

/** The lead database refuses a PDF over 3 MB; so do we, before sending. */
export const MAX_PDF_BYTES = 3 * 1024 * 1024;

export interface LeadFields {
  name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  postcode: string | null;
  bedrooms: number | null;
}

const text = (v: string | null | undefined) => (typeof v === 'string' ? v.trim() : '');

/** True when these bytes are a PDF we are willing to send. */
export function pdfSendable(pdf: Uint8Array | null | undefined): pdf is Uint8Array {
  if (!pdf || pdf.length === 0 || pdf.length > MAX_PDF_BYTES) return false;
  return pdf[0] === 0x25 && pdf[1] === 0x50 && pdf[2] === 0x44 && pdf[3] === 0x46; // %PDF
}

/** The report block, or undefined when there is no summary with figures or no sendable PDF. */
export function reportBlock(summary: ReportSummary | null, pdf: Uint8Array | null): WebsiteLeadBody['report'] | undefined {
  if (!summary || !pdfSendable(pdf)) return undefined;
  const f = summary.figures;
  const pct = Math.round(f.occupancyPct);
  if (!(f.annualIncome > 0) || pct < 0 || pct > 100) return undefined;
  return {
    gross_annual_income: f.annualIncome,
    nightly_rate: f.nightlyRate,
    occupancy_pct: pct,
    bedrooms: f.bedrooms,
    pdf_base64: Buffer.from(pdf).toString('base64'),
  };
}

export function buildPushBody(input: {
  ownerId: string;
  leadId: string;
  lead: LeadFields;
  report?: WebsiteLeadBody['report'];
}): WebsiteLeadBody {
  const { lead } = input;
  return {
    si_member_id: input.ownerId,
    si_lead_id: input.leadId,
    lead: {
      name: text(lead.name),
      email: text(lead.email),
      phone: text(lead.phone),
      address: text(lead.address),
      postcode: text(lead.postcode),
      bedrooms: lead.bedrooms === null || lead.bedrooms === undefined ? '' : String(lead.bedrooms),
      message: 'Enquired through your Stayful Intelligence website.',
    },
    ...(input.report ? { report: input.report } : {}),
  };
}

/** The body for a "Send a test lead": no landlord's details at all. */
export function buildTestBody(ownerId: string, testId: string): WebsiteLeadBody {
  return {
    si_member_id: ownerId,
    si_lead_id: testId,
    test: true,
    lead: { name: '', email: '', phone: '', address: '', postcode: '', bedrooms: '', message: '' },
  };
}
