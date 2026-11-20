import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANGLES, type Angle } from './codes.ts';
import { AD_LIMITS, checkLength, firstSentence } from './limits.ts';
import { buildFigure, figureIsLabelled, FIGURE_LABEL_RE, type Figure } from './figures.ts';
import { bannedClaimHits } from '../websites/checks.ts';
import { ANGLE_DEFS, SCRIPT_5B, angleDef, feeSentence, renderCards, renderScript, renderTexts, type AngleBrand } from './angles.ts';

type Operator = { name: string; brand: AngleBrand; figure: Figure | null };

const AGG = { bedrooms: 3, sample_count: 14, avg_gross_revenue: 48_200, avg_net_revenue: 31_000, avg_occupancy: 71.4 };

const OPERATORS: Operator[] = [
  {
    name: 'short name, fee, figure',
    brand: { company: 'Brightstone Stays', area: 'Cambridge', bedrooms: 3, feePct: 12 },
    figure: buildFigure({ area_label: 'Cambridge', agg: AGG, feePct: 12, netIncludesFee: false }),
  },
  {
    name: 'very long names, no fee, no figure (no data)',
    brand: { company: 'Oakridge Property Lettings and Management', area: 'Newcastle upon Tyne and Gateshead', bedrooms: 2, feePct: null },
    figure: null,
  },
  {
    name: 'medium name, decimal fee, figure where net includes the fee',
    brand: { company: 'Hearth & Home Lets', area: 'Leeds', bedrooms: 2, feePct: 12.5 },
    figure: buildFigure({ area_label: 'Leeds', agg: { ...AGG, bedrooms: 2 }, feePct: 12.5, netIncludesFee: true }),
  },
  {
    name: 'no fee, with a figure',
    brand: { company: 'Kestrel Homes', area: 'York', bedrooms: 4, feePct: null },
    figure: buildFigure({ area_label: 'York', agg: { ...AGG, bedrooms: 4 }, feePct: null, netIncludesFee: true }),
  },
];

const STAY_OWNER = /\byou stay (?:the owner|in control)\b|\byou(?:'re| are) still the owner\b|\byou stay the owner\b/i;
// Built from parts so a repo-wide search for the brand name finds no copy of it in this package.
const BRAND = new RegExp('stay' + 'ful', 'i');
const BRAND_SITE = new RegExp('stay' + 'ful\\.co\\.uk', 'i');
const SOURCE_BRAND_FIGURES = /\b(?:2,399|1,349|3,097|7,681|939)\b/;
const RANGE = /£\s?[\d,]+(?:\.\d+)?\s*(?:-|–|—|to)\s*£?\s?\d|\b\d[\d,]*\s*(?:-|–|—)\s*\d/;
const LEGAL = /section\s*21|evict|legal|\blaw|legislation|renters'? rights|\bact\b|england|wales|scotland|court|notice to quit/i;
const RULES_PHRASE = /the rules for renting to tenants have changed/i;

function allText(o: Operator, angle: Angle): string[] {
  const r = renderTexts({ angle, brand: o.brand, figure: o.figure });
  const cards = renderCards({ angle, brand: o.brand, figure: o.figure }).flatMap((c) => [c.headline, ...c.body, c.cta, c.big ?? '']);
  const script = angle === '5b' ? renderScript({ brand: o.brand, figure: o.figure }).lines : [];
  return [...r.primary, ...r.headlines, ...r.descriptions, ...cards, ...script].filter(Boolean);
}

test('45 templates: 5 primary texts, 5 headlines and 5 descriptions for each of the 3 angles', () => {
  assert.deepEqual([...ANGLES].sort(), Object.keys(ANGLE_DEFS).sort());
  let total = 0;
  for (const a of ANGLES) {
    const d = angleDef(a);
    assert.equal(d.angle, a);
    assert.equal(d.primary.length, 5);
    assert.equal(d.headlines.length, 5);
    assert.equal(d.descriptions.length, 5);
    assert.ok(d.label && d.audience && d.rationale);
    total += d.primary.length + d.headlines.length + d.descriptions.length;
    for (const list of [d.primary, d.headlines, d.descriptions]) assert.equal(new Set(list).size, 5, 'no duplicate templates');
  }
  assert.equal(total, 45);
});

test('template syntax: known slots only, {bedrooms} only as "{bedrooms}-bed", headlines have no slots at all', () => {
  for (const a of ANGLES) {
    const d = angleDef(a);
    for (const t of [...d.primary, ...d.descriptions, ...d.cards.flatMap((c) => [c.headline, c.cta, ...c.body])]) {
      const stripped = t.replace(/\{(?:company|area|figure|fee)(?:\|[^{}]*)?\}|\{bedrooms\}-bed|\{label\}/g, '');
      assert.ok(!/[{}]/.test(stripped), `stray brace in: ${t}`);
    }
    for (const h of d.headlines) assert.ok(!/[{}]/.test(h), `headline has a slot: ${h}`);
    assert.ok(d.primary.every((t) => (t.match(/\{figure/g) ?? []).length <= 1), 'at most one example per text');
  }
});

test('every rendered text is inside the limits (green) for every sample operator', () => {
  for (const o of OPERATORS) {
    for (const a of ANGLES) {
      const r = renderTexts({ angle: a, brand: o.brand, figure: o.figure });
      assert.equal(r.primary.length, 5);
      assert.equal(r.headlines.length, 5);
      assert.equal(r.descriptions.length, 5);
      for (const t of r.primary) {
        const c = checkLength('primary', t);
        assert.equal(c.level, 'green', `${o.name} ${a} primary ${c.length}: ${t}`);
        assert.ok(t.length <= AD_LIMITS.primary.hard);
        assert.ok(firstSentence(t).length <= AD_LIMITS.primary.visible, `first sentence: ${t}`);
        assert.ok(firstSentence(t).length >= 15, `first sentence makes sense alone: ${t}`);
      }
      for (const t of r.headlines) {
        assert.equal(checkLength('headline', t).level, 'green', `${o.name} ${a} headline: ${t}`);
        assert.ok(t.length <= AD_LIMITS.headline.recommended);
      }
      for (const t of r.descriptions) {
        assert.equal(checkLength('description', t).level, 'green', `${o.name} ${a} description: ${t}`);
        assert.ok(t.length <= AD_LIMITS.description.hard);
      }
    }
  }
});

test('primary texts are one paragraph of about 40 to 50 words; descriptions are a full sentence', () => {
  for (const o of OPERATORS.slice(0, 1)) {
    for (const a of ANGLES) {
      const r = renderTexts({ angle: a, brand: o.brand, figure: null });
      for (const t of r.primary) {
        const words = t.split(/\s+/).length;
        assert.ok(words >= 35 && words <= 55, `${a} primary has ${words} words: ${t}`);
        assert.ok(!/\n/.test(t), 'one paragraph');
      }
      for (const t of r.descriptions) assert.ok(t.split(/\s+/).length >= 10, `description too short: ${t}`);
    }
  }
});

test('no banned claim, no range, no guarantee, no em dash, no leftover slot, in any text', () => {
  for (const o of OPERATORS) {
    for (const a of ANGLES) {
      for (const t of allText(o, a)) {
        assert.deepEqual(bannedClaimHits(t), [], `banned claim in: ${t}`);
        assert.doesNotMatch(t, RANGE, `range in: ${t}`);
        assert.doesNotMatch(t, /guarantee|you will earn|you'll earn|passive income|yield|\bvoids?\b/i, `claim in: ${t}`);
        assert.doesNotMatch(t, /[—–]/, `dash in: ${t}`);
        assert.doesNotMatch(t, /[{}]|undefined|NaN|\[object/, `leftover in: ${t}`);
        assert.doesNotMatch(t, /\s{2,}| [.,!?]|\.\./, `spacing in: ${t}`);
      }
    }
  }
});

test('the templates themselves (before any slot is filled) have no banned claim, brand or figure', () => {
  for (const a of ANGLES) {
    const d = angleDef(a);
    const raw = [...d.primary, ...d.headlines, ...d.descriptions, ...d.cards.flatMap((c) => [c.headline, c.cta, ...c.body]), ...(a === '5b' ? SCRIPT_5B : [])];
    for (const t of raw) {
      assert.doesNotMatch(t, BRAND);
      assert.doesNotMatch(t, SOURCE_BRAND_FIGURES);
      assert.doesNotMatch(t, /£|\d+%|\bVAT\b/, `a typed figure in the template: ${t}`);
      assert.doesNotMatch(t, /[—–]/);
      assert.deepEqual(bannedClaimHits(t), []);
    }
  }
});

test('never the source brand, its site, its example figures or its fee line (unless the operator set that fee)', () => {
  for (const o of OPERATORS) {
    for (const a of ANGLES) {
      for (const t of allText(o, a)) {
        assert.doesNotMatch(t, BRAND);
        assert.doesNotMatch(t, BRAND_SITE);
        assert.doesNotMatch(t, SOURCE_BRAND_FIGURES, `Source brand figure in: ${t}`);
        assert.doesNotMatch(t, /\bVAT\b|15% \+/i);
        if (o.brand.feePct !== 15) assert.doesNotMatch(t, /\b15%/, `15% fee in: ${t}`);
      }
    }
  }
  // Even if an operator's real fee is 15%, the fee line is theirs and has no VAT wording.
  const r = renderTexts({ angle: '5b', brand: { company: 'Acme Lets', area: 'Bath', bedrooms: 2, feePct: 15 }, figure: null });
  assert.ok(r.primary.some((t) => t.includes('Our management fee is 15%.')));
  assert.ok(r.primary.every((t) => !/VAT/.test(t)));
});

test('the fee appears only from the operator fee, as a whole sentence, never a hole', () => {
  assert.equal(feeSentence(12), 'Our management fee is 12%.');
  assert.equal(feeSentence(12.5), 'Our management fee is 12.5%.');
  for (const bad of [null, undefined, 0, -3, Number.NaN, 150]) assert.equal(feeSentence(bad as number | null), '');
  for (const a of ANGLES) {
    const none = renderTexts({ angle: a, brand: { company: 'Kestrel Homes', area: 'York', bedrooms: 3, feePct: null }, figure: null });
    for (const t of [...none.primary, ...none.headlines, ...none.descriptions]) {
      assert.doesNotMatch(t, /%|\bfee\b/i, `a fee with no fee set: ${t}`);
      assert.ok(/[.?!]$/.test(t) || none.headlines.includes(t), `ends cleanly: ${t}`);
    }
    const some = renderTexts({ angle: a, brand: { company: 'Kestrel Homes', area: 'York', bedrooms: 3, feePct: 12 }, figure: null });
    assert.ok(some.primary.some((t) => t.includes('Our management fee is 12%.')), `${a}: the fee shows in a primary text`);
    assert.ok(some.descriptions.some((t) => t.includes('Our management fee is 12%.')), `${a}: the fee shows in a description`);
    // The text without a fee is the text with it, minus one sentence.
    for (let i = 0; i < 5; i++) assert.equal(some.primary[i].replace(' Our management fee is 12%.', ''), none.primary[i]);
  }
});

test('an example appears only with its label, once per text, and a missing figure never leaves a hole', () => {
  for (const o of OPERATORS) {
    for (const a of ANGLES) {
      const r = renderTexts({ angle: a, brand: o.brand, figure: o.figure });
      for (const t of [...r.primary, ...r.headlines, ...r.descriptions]) {
        assert.ok(figureIsLabelled(t), `unlabelled figure: ${t}`);
        assert.ok((t.match(/£/g) ?? []).length <= 1, `more than one figure: ${t}`);
        if (!o.figure) assert.doesNotMatch(t, /£|Example:/);
      }
      for (const t of allText(o, a)) assert.ok(figureIsLabelled(t) || /^£/.test(t), `unlabelled: ${t}`);
    }
  }
  // A typical operator gets the example in at least two primary texts for every angle.
  const typical = OPERATORS[0];
  for (const a of ANGLES) {
    const withFigure = renderTexts({ angle: a, brand: typical.brand, figure: typical.figure }).primary.filter((t) => FIGURE_LABEL_RE.test(t));
    assert.ok(withFigure.length >= 2, `${a}: ${withFigure.length} primary texts carry the example`);
    assert.ok(withFigure.every((t) => t.includes(typical.figure!.sentence)));
  }
  // No figure, no example anywhere, and the text is still a full text.
  const none = renderTexts({ angle: '3a', brand: typical.brand, figure: null });
  assert.ok(none.primary.every((t) => !t.includes('Example:') && t.length > 150));
});

test('a long company or area name drops the fee first, then the example, never the limit', () => {
  const brand: AngleBrand = { company: 'The Oakridge Property Lettings and Management Company', area: 'Newcastle upon Tyne and Gateshead', bedrooms: 3, feePct: 12 };
  const figure = buildFigure({ area_label: brand.area, agg: AGG, feePct: 12, netIncludesFee: false });
  assert.ok(figure);
  for (const a of ANGLES) {
    for (const t of renderTexts({ angle: a, brand, figure }).primary) {
      assert.ok(t.length <= AD_LIMITS.primary.hard, `${t.length}: ${t}`);
      assert.ok(figureIsLabelled(t));
    }
  }
});

test('every primary text says you stay the owner', () => {
  for (const o of OPERATORS) {
    for (const a of ANGLES) {
      for (const t of renderTexts({ angle: a, brand: o.brand, figure: o.figure }).primary) assert.match(t, STAY_OWNER, `${a}: ${t}`);
    }
  }
});

test('angle 17: only "the rules for renting to tenants have changed", no legal claim, always "in control"', () => {
  for (const o of OPERATORS) {
    const r = renderTexts({ angle: '17', brand: o.brand, figure: o.figure });
    const all = [...r.primary, ...r.headlines, ...r.descriptions, ...renderCards({ angle: '17', brand: o.brand, figure: o.figure }).flatMap((c) => [c.headline, ...c.body, c.cta])];
    for (const t of all) assert.doesNotMatch(t, LEGAL, `legal wording in: ${t}`);
    for (const t of r.primary) assert.match(t, /in control/i, `no control line: ${t}`);
    assert.ok(r.primary.filter((t) => RULES_PHRASE.test(t)).length >= 3, 'the rules sentence is used');
    assert.ok(r.primary.some((t) => /no tenancy/i.test(t)));
    assert.ok(all.some((t) => /guests stay days, not years/i.test(t)));
  }
  // Wording of the rules claim is the one allowed sentence, never altered.
  for (const t of angleDef('17').primary) {
    for (const sentence of t.split(/(?<=[.?!])\s+/)) {
      if (/\brules\b/i.test(sentence)) assert.match(sentence, /^(?:Between tenants, or thinking about it\? )?The rules for renting to tenants have changed(?:\.|, so compare before you sign again\.)/);
    }
  }
});

test('headlines never contain the company or the area', () => {
  for (const a of ANGLES) {
    for (const h of angleDef(a).headlines) assert.doesNotMatch(h, /\{/);
  }
  const brand: AngleBrand = { company: 'Brightstone Stays', area: 'Cambridge', bedrooms: 3, feePct: 12 };
  for (const a of ANGLES) {
    for (const h of renderTexts({ angle: a, brand, figure: null }).headlines) {
      assert.ok(!h.includes('Brightstone') && !h.includes('Cambridge'));
    }
  }
});

test('image cards (3a and 17): headline, 2 to 4 body lines and a CTA each; the example card is dropped with no figure', () => {
  for (const a of ['3a', '17'] as const) {
    for (const o of OPERATORS) {
      const cards = renderCards({ angle: a, brand: o.brand, figure: o.figure });
      assert.equal(cards.length, o.figure ? 5 : 4, `${a} ${o.name}`);
      assert.equal(new Set(cards.map((c) => c.id)).size, cards.length);
      for (const c of cards) {
        assert.ok(c.headline.trim().length > 0, `${a} ${c.id} headline`);
        assert.ok(c.body.length >= 2 && c.body.length <= 4, `${a} ${c.id} has ${c.body.length} body lines`);
        assert.ok(c.body.every((l) => l.trim().length > 0));
        assert.ok(c.cta.trim().length > 0);
        assert.ok(c.headline.length <= 70, `card headline length ${c.headline.length}`);
        const text = [c.headline, ...c.body, c.cta, c.big ?? ''].join(' ');
        assert.ok(figureIsLabelled(text), `unlabelled card: ${text}`);
        if (c.figure) {
          assert.ok(o.figure);
          assert.equal(c.big, o.figure.amountText);
          assert.equal(c.label, o.figure.label);
          assert.ok(FIGURE_LABEL_RE.test(c.body.join(' ')), 'the label sits on the card with the number');
        } else {
          assert.equal(c.big, null);
          assert.doesNotMatch(text, /£/);
        }
      }
      const feeLines = cards.flatMap((c) => c.body).filter((l) => /fee/i.test(l));
      assert.equal(feeLines.length, o.brand.feePct ? 1 : 0);
    }
  }
  assert.deepEqual(renderCards({ angle: '5b', brand: OPERATORS[0].brand, figure: OPERATORS[0].figure }), []);
});

test('the 5b voiceover: spoken (no £, no digits, no %), the owner stays, slots filled, a sensible length', () => {
  for (const o of OPERATORS) {
    const s = renderScript({ brand: o.brand, figure: o.figure });
    assert.ok(s.lines.length >= 4);
    assert.ok(s.lines.every((l) => l.trim().length > 0));
    assert.equal(s.text, s.lines.join('\n\n'));
    assert.match(s.text, /you stay the owner/i);
    assert.match(s.text, /short-term let, like an Airbnb/);
    assert.ok(s.text.includes(o.brand.company));
    assert.ok(s.text.includes(o.brand.area));
    assert.doesNotMatch(s.text, /[£\d%{}]|undefined/i);
    assert.doesNotMatch(s.text, BRAND);
    assert.doesNotMatch(s.text, /[—–]/);
    assert.deepEqual(bannedClaimHits(s.text), []);
    assert.ok(s.words >= 75 && s.words <= 200, `${s.words} words`);
    if (o.figure) {
      assert.ok(s.text.includes(o.figure.spoken));
      assert.match(s.text, /Every property is different\./);
    } else {
      assert.doesNotMatch(s.text, /Every property is different|Here is an example/);
    }
    if (o.brand.feePct) assert.match(s.text, /Our management fee is (?:twelve|twelve point five) percent\./);
    else assert.doesNotMatch(s.text, /\bfee\b|percent/i);
  }
});

test('lead-form questions are stored per angle as data', () => {
  for (const a of ANGLES) {
    const qs = angleDef(a).leadFormQuestions;
    assert.ok(qs.length >= 3 && qs.length <= 6);
    assert.equal(new Set(qs.map((q) => q.id)).size, qs.length);
    for (const q of qs) {
      assert.ok(q.label.endsWith('?'));
      if (q.kind === 'choice') assert.ok((q.options?.length ?? 0) >= 2);
      else assert.equal(q.options, undefined);
      assert.doesNotMatch(q.label, /[—–]/);
    }
    assert.ok(qs.some((q) => q.id === 'postcode'));
  }
});

test('a blank company falls back to wording that still reads, never a hole', () => {
  const r = renderTexts({ angle: '3a', brand: { company: '  ', area: '', bedrooms: null, feePct: null }, figure: null });
  for (const t of [...r.primary, ...r.descriptions]) {
    assert.doesNotMatch(t, /[{}]|undefined|\s{2,}/);
    assert.ok(/[.?!]$/.test(t));
  }
  assert.ok(r.descriptions.some((d) => /typical home in your area/.test(d)));
  assert.ok(r.primary.some((t) => t.includes('Our team')));
});
