/**
 * Review R4 (R4-31, Zac 19 Nov 2026): the buy-to-let settings Zac can change
 * on /admin/deals/btl: the £2 report's price (billing_settings.btl_report_pence)
 * and the finance (billing_settings.btl_finance: loan-to-value, the stress
 * rate's margin and floor, the lender's rent cover, and the rate used when no
 * live rate is cached). Every other btl_* setting stays SQL-only.
 *
 * Each field is checked against the same bounds the readers apply
 * (config.ts parseBtlReportPence, parseBtlFinance), so a saved value is never
 * silently read back as its default: an out-of-range field is refused with a
 * message and nothing is saved. BTL keeps the LIVE rate for everyone (the
 * fallback is only for a day with no cached rate).
 *
 * Pure: no network, no database, no server-only.
 */
import { BTL_FINANCE_KEY, BTL_REPORT_PENCE_KEY, type BtlFinance } from './config.ts';

/** The two rows the form writes, and nothing else. */
export const BTL_FORM_KEYS = [BTL_REPORT_PENCE_KEY, BTL_FINANCE_KEY] as const;

interface Field {
  label: string;
  min: number;
  max: number;
  whole: boolean;
}

/** The report's price, pence (the same bounds as parseBtlReportPence). */
export const BTL_REPORT_FIELD: Field = { label: 'Buy-to-let report price (pence)', min: 0, max: 10_000, whole: true };

/** The finance fields (the same bounds as parseBtlFinance). */
export const BTL_FINANCE_FIELDS: Record<keyof BtlFinance, Field> = {
  ltvPct: { label: 'Loan-to-value (%)', min: 1, max: 95, whole: false },
  stressAddPct: { label: 'Stress rate: live rate plus (%)', min: 0, max: 10, whole: false },
  stressFloorPct: { label: 'Stress rate: at least (%)', min: 0, max: 25, whole: false },
  icrPct: { label: 'Rent cover: rent at least this % of the stressed interest', min: 100, max: 250, whole: false },
  fallbackRatePct: { label: 'Rate when no live rate is cached (%)', min: 0.1, max: 25, whole: false },
};

export type BtlSettingsForm = { ok: true; reportPence: number; finance: BtlFinance } | { ok: false; error: string };

function numberIn(raw: string | null, f: Field): number | null {
  const t = (raw ?? '').trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || (f.whole && !Number.isInteger(n)) || n < f.min || n > f.max) return null;
  return n;
}

/** The form's fields, checked. `get` reads one field (FormData.get as a string, or null). */
export function validateBtlSettingsForm(get: (name: string) => string | null): BtlSettingsForm {
  const reportPence = numberIn(get('reportPence'), BTL_REPORT_FIELD);
  if (reportPence === null) return { ok: false, error: `${BTL_REPORT_FIELD.label}: a whole number from ${BTL_REPORT_FIELD.min} to ${BTL_REPORT_FIELD.max}.` };
  const finance = {} as BtlFinance;
  for (const [key, f] of Object.entries(BTL_FINANCE_FIELDS) as [keyof BtlFinance, Field][]) {
    const v = numberIn(get(key), f);
    if (v === null) return { ok: false, error: `${f.label}: a number from ${f.min} to ${f.max}.` };
    finance[key] = v;
  }
  return { ok: true, reportPence, finance };
}
