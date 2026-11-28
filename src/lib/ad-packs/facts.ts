/**
 * Batch 55 step 5 (Phase 2, 55c rule 3): the facts a lead database customer's ads may claim, per customer.
 *
 * An ad line may say only what is on this list:
 *   - what the income report contains (REPORT_CONTENTS): gross and net, occupancy, short let vs long let, a 12-month
 *     forecast, nearby comparable listings, local demand
 *   - that it is free and takes about a minute
 *   - the customer's company, their areas, their own fee (only when set) and contact details
 *   - "you stay the owner"
 *   - the one labelled area example (figures.ts), unchanged
 *
 * `checkLineAgainstFacts` is the machine side of the rule. It cannot read meaning, so it checks what can be checked:
 *   - no forbidden claim (you will earn, a guarantee, exclusive, "up to", risk free, best, a range, no voids)
 *   - no source-brand word or figure (built from parts so a search for the name finds no copy here)
 *   - every number in the line is a number the facts allow (the fee, 12 for the forecast, the figure's own numbers,
 *     the customer's bedroom counts); spoken lines carry numbers in words, so they rarely have any
 *   - a percentage is only ever the customer's own fee
 *   - a £ amount is only ever the labelled example's, inside its label
 *
 * Pure: no network, no database, no server-only.
 */
import { bannedClaimHits } from '../websites/checks.ts';
import { FIGURE_LABEL_RE, type Figure } from './figures.ts';

export const REPORT_CONTENTS = ['gross and net income', 'occupancy', 'short let vs long let', '12-month forecast', 'nearby comparable listings', 'local demand'] as const;

export type AdFacts = {
  company: string;
  areas: string[];
  /** The customer's own fee percent, or null (then no percentage may appear at all). */
  feePct: number | null;
  /** The labelled example the pack rests on, or null. */
  figure: Pick<Figure, 'amount' | 'bedrooms' | 'sampleCount' | 'label'> | null;
  /** Bedroom counts the customer serves (from the pushed range), for a "3-bed" line. */
  bedrooms: number[];
  reportContents: readonly string[];
  free: true;
  aboutAMinute: true;
  youStayTheOwner: true;
};

export function factsFor(i: {
  company: string;
  areas: readonly string[];
  feePct: number | null;
  figure: Figure | null;
  bedrooms?: { min: number; max: number } | number | null;
}): AdFacts {
  const beds: number[] = [];
  if (typeof i.bedrooms === 'number' && Number.isInteger(i.bedrooms)) beds.push(i.bedrooms);
  else if (i.bedrooms && typeof i.bedrooms === 'object') for (let b = Math.max(0, i.bedrooms.min); b <= Math.min(10, i.bedrooms.max); b++) beds.push(b);
  if (i.figure) beds.push(i.figure.bedrooms);
  return {
    company: String(i.company ?? '').replace(/\s+/g, ' ').trim(),
    areas: i.areas.map((a) => String(a).trim()).filter(Boolean),
    feePct: typeof i.feePct === 'number' && Number.isFinite(i.feePct) && i.feePct > 0 && i.feePct <= 100 ? i.feePct : null,
    figure: i.figure ? { amount: i.figure.amount, bedrooms: i.figure.bedrooms, sampleCount: i.figure.sampleCount, label: i.figure.label } : null,
    bedrooms: [...new Set(beds)],
    reportContents: REPORT_CONTENTS,
    free: true,
    aboutAMinute: true,
    youStayTheOwner: true,
  };
}

export type FactProblem = { rule: string; detail: string };

const SOURCE_RE = new RegExp('stay' + 'ful', 'i');
const SOURCE_FIGURES_RE = /(?<![\d,.])(?:2,?399|1,?349|3,?097|7,?681|939)(?![\d]|,\d)/;
const FORBIDDEN: { re: RegExp; rule: string; detail: string }[] = [
  { re: /\bguarantee[sd]?\b/i, rule: 'guarantee', detail: 'It promises a guarantee.' },
  { re: /\bexclusive(?:ly)?\b/i, rule: 'exclusive', detail: 'It says "exclusive".' },
  { re: /\bup\s+to\b|\bas\s+much\s+as\b/i, rule: 'up_to', detail: 'It uses an "up to" claim.' },
  { re: /\brisk[- ]free\b|\bno\s+risk\b/i, rule: 'risk_free', detail: 'It says there is no risk.' },
  { re: /\b(?:the\s+)?best\b|\bnumber\s+one\b|\b#1\b/i, rule: 'superlative', detail: 'It claims to be the best.' },
  { re: /\byou(?:\s+will|'ll)\s+(?:earn|make|get)\b/i, rule: 'you_will_earn', detail: 'It says "you will earn".' },
  { re: /\bdouble\b|\btriple\b|\b\d+x\b/i, rule: 'multiple', detail: 'It claims a multiple of income.' },
];

const NUM_RE = /£?\s?\d[\d,]*(?:\.\d+)?\s?%?/g;

/** The numbers the facts allow in a line. */
export function allowedNumbers(f: AdFacts): Set<number> {
  const s = new Set<number>([12]);
  if (f.feePct !== null) s.add(f.feePct);
  for (const b of f.bedrooms) s.add(b);
  if (f.figure) {
    s.add(f.figure.amount);
    s.add(f.figure.bedrooms);
    s.add(f.figure.sampleCount);
  }
  return s;
}

/** Problems with one ad line against the customer's facts ([] when it passes). */
export function checkLineAgainstFacts(line: string, f: AdFacts): FactProblem[] {
  const text = String(line ?? '').replace(/\s+/g, ' ').trim();
  const out: FactProblem[] = [];
  if (text === '') return out;
  if (SOURCE_RE.test(text)) out.push({ rule: 'source_brand', detail: 'It names a brand that is not yours.' });
  if (SOURCE_FIGURES_RE.test(text)) out.push({ rule: 'source_figure', detail: 'It carries someone else’s example figure.' });
  for (const c of FORBIDDEN) if (c.re.test(text)) out.push({ rule: c.rule, detail: c.detail });
  for (const h of bannedClaimHits(text)) out.push({ rule: h.id, detail: `It makes ${h.what}.` });
  // The company name and the area may carry digits of their own ("Flat 9 Lets", "NG7"): they are not claims.
  let scan = text;
  for (const own of [f.company, ...f.areas]) if (own) scan = scan.split(own).join(' ');
  // The labelled example sentence may carry its own numbers, and only inside its label.
  const labelled = f.figure !== null && FIGURE_LABEL_RE.test(scan);
  if (labelled && f.figure) scan = scan.replace(FIGURE_LABEL_RE, ' ');
  const allowed = allowedNumbers(f);
  NUM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUM_RE.exec(scan))) {
    const raw = m[0];
    const n = Number(raw.replace(/[£%,\s]/g, ''));
    if (!Number.isFinite(n)) continue;
    if (raw.includes('%')) {
      if (f.feePct === null || n !== f.feePct) out.push({ rule: 'percent_not_fee', detail: `It carries ${raw.trim()}, which is not your own fee.` });
      continue;
    }
    if (raw.includes('£')) {
      if (!labelled || !f.figure || n !== f.figure.amount) out.push({ rule: 'pound_not_example', detail: 'It has a £ amount that is not the labelled example.' });
      continue;
    }
    if (!allowed.has(n)) out.push({ rule: 'number_not_fact', detail: `It carries the number ${raw.trim()}, which is not on your facts list.` });
  }
  return out;
}
