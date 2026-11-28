import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANGLES } from './codes.ts';
import { buildFigure, figureIsLabelled, type Figure } from './figures.ts';
import { AD_LIMITS, checkLength, firstSentence } from './limits.ts';
import { bannedClaimHits } from '../websites/checks.ts';
import { ANGLE_DEFS, SCRIPT_5B } from './angles.ts';
import { CTA_LINE, LD_ANGLE_DEFS, ldConceptFor, renderLdPack, renderLdTexts, type LdBrand } from './ld-angles.ts';
import { factsFor, checkLineAgainstFacts } from './facts.ts';
import { AD_FORMATS, CONCEPT_ID_RE } from './concepts.ts';

const AGG = { bedrooms: 3, sample_count: 14, avg_gross_revenue: 48_200, avg_net_revenue: 31_000, avg_occupancy: 71.4 };

const CUSTOMERS: { name: string; brand: LdBrand; figure: Figure | null }[] = [
  { name: 'short, fee, figure', brand: { company: 'Harbour & Pine', area: 'Leicester', feePct: 12 }, figure: buildFigure({ area_label: 'Leicester', agg: AGG, feePct: 12, netIncludesFee: false }) },
  { name: 'very long names, no fee, no figure', brand: { company: 'Oakridge Property Lettings and Management', area: 'Newcastle upon Tyne and Gateshead', feePct: null }, figure: null },
  { name: 'decimal fee, long company, figure', brand: { company: 'Oakridge Property Lettings and Management', area: 'Newcastle upon Tyne and Gateshead', feePct: 12.5 }, figure: buildFigure({ area_label: 'Newcastle upon Tyne and Gateshead', agg: AGG, feePct: 12.5, netIncludesFee: true }) },
  { name: 'empty brand', brand: { company: '', area: '', feePct: null }, figure: null },
];

const BRAND = new RegExp('stay' + 'ful', 'i');

for (const c of CUSTOMERS) {
  const pack = renderLdPack(c.brand, c.figure);
  const area = c.brand.area || 'your area';

  test(`ld copy (${c.name}): every primary text says the audience, area, "free" and "report" in its first 125 characters`, () => {
    for (const a of ANGLES) {
      for (const t of pack[a].primary) {
        const head = t.slice(0, AD_LIMITS.primary.visible);
        assert.match(head, /\b(?:Landlords|Homeowners)\b/, t);
        assert.ok(head.includes(area), t);
        assert.match(head, /\bfree\b/i, t);
        assert.match(head, /\breport\b/i, t);
      }
    }
  });

  test(`ld copy (${c.name}): no question mark in a first sentence, "you stay the owner" in every primary, CTA last`, () => {
    for (const a of ANGLES) {
      for (const t of pack[a].primary) {
        assert.ok(!firstSentence(t).includes('?'), t);
        assert.match(t, /\byou stay the owner\b/i, t);
        assert.ok(t.endsWith(`${CTA_LINE}.`), t);
      }
      assert.equal(pack[a].screenLines.at(-1), CTA_LINE);
      assert.ok(!pack[a].screenLines[0].includes('?'), pack[a].screenLines[0]);
      if (pack[a].script) {
        assert.match(pack[a].script![0], /\bfree\b.*\breport\b/i);
        assert.equal(pack[a].script!.at(-1), `${CTA_LINE}.`);
      }
    }
  });

  test(`ld copy (${c.name}): no line is in two ads of the pack (the CTA excepted)`, () => {
    const seen = new Map<string, string>();
    for (const a of ANGLES) {
      const r = pack[a];
      const mine = new Set([...r.primary, ...r.headlines, ...r.descriptions, ...r.screenLines, ...(r.script ?? [])].map((l) => l.toLowerCase().replace(/[.\s]+$/, '')));
      for (const l of mine) {
        if (l === CTA_LINE.toLowerCase()) continue;
        assert.ok(!seen.has(l) || seen.get(l) === a, `"${l}" is in ${seen.get(l)} and ${a}`);
        seen.set(l, a);
      }
    }
  });

  test(`ld copy (${c.name}): sentence case, UK English, no exclamation marks or em dashes, lengths fit, nothing banned`, () => {
    for (const a of ANGLES) {
      const r = pack[a];
      for (const t of [...r.primary, ...r.headlines, ...r.descriptions, ...r.screenLines, ...(r.script ?? [])]) {
        assert.ok(!/[!—]/.test(t), t);
        assert.ok(!BRAND.test(t), t);
        assert.ok(!/\{|\}/.test(t), `unfilled slot: ${t}`);
        assert.deepEqual(bannedClaimHits(t), [], t);
        assert.ok(figureIsLabelled(t), t);
        assert.ok(!/\b(?:color|realize|apartment|vacation)\b/i.test(t), t);
      }
      for (const t of r.primary) assert.notEqual(checkLength('primary', t).level, 'red', t);
      for (const t of r.headlines) {
        assert.notEqual(checkLength('headline', t).level, 'red', t);
        assert.ok(!/\b[A-Z][a-z]+ [A-Z][a-z]+ [A-Z]/.test(t.replace(c.brand.company, '')), `title case? ${t}`);
      }
      for (const t of r.descriptions) assert.ok(t.length <= 34, `description about 30: ${t}`);
    }
  });

  test(`ld copy (${c.name}): every copy, on-screen and spoken line passes the facts list`, () => {
    const facts = factsFor({ company: c.brand.company, areas: [c.brand.area], feePct: c.brand.feePct, figure: c.figure, bedrooms: { min: 2, max: 3 } });
    for (const a of ANGLES) {
      const r = pack[a];
      for (const t of [...r.primary, ...r.headlines, ...r.descriptions, ...r.screenLines, ...(r.script ?? [])]) assert.deepEqual(checkLineAgainstFacts(t, facts), [], t);
    }
  });
}

test('ld copy: the fee appears only when the customer set one, and is their own', () => {
  const withFee = renderLdPack({ company: 'A', area: 'York', feePct: 11 }, null);
  const noFee = renderLdPack({ company: 'A', area: 'York', feePct: null }, null);
  assert.ok(withFee['5b'].primary.some((t) => t.includes('Our management fee is 11%.')));
  assert.ok(withFee['5b'].script!.some((l) => l.includes('eleven percent')));
  for (const a of ANGLES) for (const t of [...noFee[a].primary, ...(noFee[a].script ?? [])]) assert.ok(!/%|percent/.test(t), t);
});

test('ld copy: frame one has two wordings, both offer first', () => {
  for (const a of ANGLES) {
    const A = renderLdTexts({ angle: a, brand: { company: 'X', area: 'Leeds', feePct: null }, figure: null, look: { base: 'cream', hook: 'a' } }).screenLines[0];
    const B = renderLdTexts({ angle: a, brand: { company: 'X', area: 'Leeds', feePct: null }, figure: null, look: { base: 'white', hook: 'b' } }).screenLines[0];
    assert.notEqual(A, B);
    for (const f of [A, B]) {
      assert.ok(f.includes('Leeds'));
      assert.match(f, /\bfree\b/i);
      assert.match(f, /\breport\b/i);
    }
  }
});

test('ld concepts: three different formats, ids in the column shape, one plain line each', () => {
  const formats = ANGLES.map((a) => ldConceptFor(a).format);
  assert.deepEqual(formats, ['phone_recording', 'report_carousel', 'loupe']);
  assert.equal(new Set(formats).size, 3);
  for (const a of ANGLES) {
    const { conceptId, format } = ldConceptFor(a);
    assert.match(conceptId, CONCEPT_ID_RE);
    assert.ok((AD_FORMATS as readonly string[]).includes(format));
    assert.match(LD_ANGLE_DEFS[a].concept.forWho, /^For /);
  }
  assert.equal(ldConceptFor('5b').conceptId, '5b-tenant-leaving');
  assert.equal(ldConceptFor('3a').conceptId, '3a-moving-abroad');
  assert.equal(ldConceptFor('17').conceptId, '17-rules-changed');
});

test('ld copy: the lead form questions stay those of batch 38, and the Academy templates are untouched', () => {
  for (const a of ANGLES) assert.deepEqual(LD_ANGLE_DEFS[a].leadFormQuestions, ANGLE_DEFS[a].leadFormQuestions);
  // The Academy's first templates, pinned: ld-angles.ts must never be reached by rewriting angles.ts in place.
  assert.ok(ANGLE_DEFS['5b'].primary[0].startsWith('Tenant handed in their notice? Before your agent relets'));
  assert.ok(SCRIPT_5B[0].startsWith('Has your tenant handed in their notice?'));
  assert.equal(ANGLE_DEFS['3a'].cards.length, 5);
});
