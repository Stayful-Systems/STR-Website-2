import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SLUG_PATTERN } from './config.ts';
import { CHIP_ORDER } from '../intelligence/config.ts';
import { checkContent, renderEntry, SAMPLE_MEMBER } from './render.ts';
import { LEGACY_REFS, SEED, refToSlug } from './seed.ts';
import { schemaSnapshot } from './test-fixtures.ts';

test('every seed passes the approval checks against the schema seeds', () => {
  const g = schemaSnapshot();
  for (const e of SEED) {
    const c = checkContent(e, g);
    assert.deepEqual(c.errors, [], `${e.slug}: ${c.errors.join(' | ')}`);
  }
});

test('slugs are unique and valid; every chip has an entry on the view', () => {
  const slugs = SEED.map((e) => e.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  for (const s of slugs) assert.match(s, SLUG_PATTERN);
  for (const chip of CHIP_ORDER) {
    const e = SEED.find((x) => x.slug === chip);
    assert.ok(e, `chip ${chip} has no seed entry`);
    assert.ok(e.channels.includes('view'), chip);
  }
});

test('every seed renders for a sample member', () => {
  const g = schemaSnapshot({ callsLive: true });
  for (const e of SEED) {
    const r = renderEntry(e, g, SAMPLE_MEMBER);
    assert.equal(r.kind, 'ok', `${e.slug}: ${JSON.stringify(r)}`);
  }
});

test('the old knowledge ids all point at seed slugs', () => {
  const slugs = new Set(SEED.map((e) => e.slug));
  for (const [old, slug] of Object.entries(LEGACY_REFS)) assert.ok(slugs.has(slug), `${old} → ${slug}`);
  assert.equal(refToSlug('[faq.3]'), 'bold_claims');
  assert.equal(refToSlug(' [credits] '), 'credits');
  assert.equal(refToSlug(''), null);
});

test('the seed plan inserts, proposes, skips and leaves alone', async () => {
  const { planSeed } = await import('./seed.ts');
  const { contentHash } = await import('./render.ts');
  const [a, b, c, d] = SEED;
  const rows = [
    { slug: b.slug, seedHash: contentHash(b), draftState: 'none' as const, draftSource: null },
    { slug: c.slug, seedHash: 'old', draftState: 'none' as const, draftSource: null },
    { slug: d.slug, seedHash: 'old', draftState: 'pending' as const, draftSource: 'manual' },
  ];
  const p = planSeed(rows, [a, b, c, d], contentHash);
  assert.deepEqual(p.insert.map((e) => e.slug), [a.slug]);
  assert.deepEqual(p.unchanged, [b.slug]);
  assert.deepEqual(p.propose.map((e) => e.slug), [c.slug]);
  assert.deepEqual(p.skipped.map((s) => s.slug), [d.slug]);
  const again = planSeed([{ slug: d.slug, seedHash: 'old', draftState: 'pending', draftSource: 'seed' }], [d], contentHash);
  assert.deepEqual(again.propose.map((e) => e.slug), [d.slug]);
});

test('the service facts use only known placeholders, all resolving from the schema seeds, and type no prices', async () => {
  const { SERVICE_FACTS } = await import('./service-facts.ts');
  const { parseTemplate } = await import('./template.ts');
  const { PLACEHOLDERS } = await import('./placeholders.ts');
  const p = parseTemplate(SERVICE_FACTS);
  assert.ok(p.ok, p.ok ? '' : p.error);
  const g = schemaSnapshot();
  for (const n of p.placeholders) {
    assert.ok(PLACEHOLDERS[n], `unknown {${n}}`);
    assert.notEqual(PLACEHOLDERS[n].resolve(g, null), null, `{${n}} doesn't resolve`);
  }
  assert.doesNotMatch(SERVICE_FACTS, /£\s?\d|\d+p\b/);
});

// Review R4 (R4-46): the service facts pass the same blocking number check approval runs, once placeholders are taken out.
test('every figure in the service facts is a placeholder (the approval number check finds nothing)', async () => {
  const { SERVICE_FACTS } = await import('./service-facts.ts');
  const { bareText, parseTemplate } = await import('./template.ts');
  const { figureCheck } = await import('./figures.ts');
  const p = parseTemplate(SERVICE_FACTS);
  assert.ok(p.ok, p.ok ? '' : p.error);
  assert.deepEqual(figureCheck(bareText(p.parts)).blocking, []);
});

// Review R4 (R4-45): a figure the nightly drafter may quote always has a draft answer for Zac to approve.
test('every service-facts placeholder is used by at least one seed entry', async () => {
  const { SERVICE_FACTS } = await import('./service-facts.ts');
  const { parseTemplate } = await import('./template.ts');
  const facts = parseTemplate(SERVICE_FACTS);
  assert.ok(facts.ok);
  const used = new Set<string>();
  for (const e of SEED) {
    for (const t of [e.question, e.answer]) {
      const p = parseTemplate(t);
      if (p.ok) for (const n of p.placeholders) used.add(n);
    }
  }
  const missing = facts.placeholders.filter((n) => !used.has(n));
  assert.deepEqual(missing, [], `no seed entry uses ${missing.map((n) => `{${n}}`).join(', ')}`);
});

// Review R3 (R3-146): a retired entry is left alone, whatever its seed text does.
test('the seed plan skips a retired entry whose seed text changed', async () => {
  const { planSeed } = await import('./seed.ts');
  const e = SEED[0];
  const plan = planSeed([{ slug: e.slug, seedHash: 'old', draftState: 'none', draftSource: null, retired: true }], [e], () => 'different');
  assert.deepEqual(plan.propose, []);
  assert.deepEqual(plan.skipped, [{ slug: e.slug, reason: 'retired' }]);
  const same = planSeed([{ slug: e.slug, seedHash: 'same', draftState: 'none', draftSource: null, retired: true }], [e], () => 'same');
  assert.deepEqual(same.unchanged, [e.slug]);
});

// Batch 38b: the ad pack's video is part of the pack; the draft says so, the count is a placeholder, nothing says "later release".
test('the ad pack drafts cover the tenant notice video and its voice, with the count as a placeholder', async () => {
  const { SERVICE_FACTS } = await import('./service-facts.ts');
  const adpack = SEED.filter((e) => e.slug.startsWith('adpack_'));
  assert.deepEqual(adpack.map((e) => e.slug), ['adpack_what', 'adpack_who', 'adpack_regenerate', 'adpack_video_voice', 'adpack_video_email', 'adpack_tagging', 'adpack_not_included', 'adpack_ld_calculator', 'adpack_ld_rounds', 'adpack_audience', 'adpack_ld_ad_leads', 'adpack_ld_brand_from_leaddb']);
  const voice = SEED.find((e) => e.slug === 'adpack_video_voice');
  assert.ok(voice);
  assert.match(voice.answer, /\{ad_pack_voice_changes\}/);
  assert.match(voice.answer, /sample/);
  assert.match(voice.answer, /few minutes/);
  assert.match(voice.answer, /isn’t available yet/);
  assert.deepEqual(voice.channels, ['view', 'chat']);
  assert.match(SEED.find((e) => e.slug === 'adpack_what')!.answer, /voiceover/);
  // The completion email: a draft with no figure in it, and the facts say it sits outside the daily email limit.
  const email = SEED.find((e) => e.slug === 'adpack_video_email');
  assert.ok(email);
  assert.match(email.answer, /email/);
  assert.doesNotMatch(email.answer, /\d/);
  assert.match(SERVICE_FACTS, /emailed once when the video is ready/);
  for (const e of adpack) assert.doesNotMatch(`${e.question} ${e.variants.join(' ')} ${e.answer}`, /later release|coming soon|arrives/i, e.slug);
  assert.doesNotMatch(SERVICE_FACTS, /later release|arrives in a later|don't promise a date/);
  assert.match(SERVICE_FACTS, /tenant notice video/i);
  assert.match(SERVICE_FACTS, /\{ad_pack_voice_changes\}/);
});

// Batch 55 (Part A): the lead database ad route drafts. Drafts only, counts are placeholders, nothing typed.
test('the lead database ad pack drafts exist, use the two new placeholders and type no figure', async () => {
  const { SERVICE_FACTS } = await import('./service-facts.ts');
  const calc = SEED.find((e) => e.slug === 'adpack_ld_calculator');
  const rounds = SEED.find((e) => e.slug === 'adpack_ld_rounds');
  const audience = SEED.find((e) => e.slug === 'adpack_audience');
  assert.ok(calc && rounds && audience);
  assert.match(calc.answer, /\{ad_calc_reports_per_day\}/);
  assert.match(calc.answer, /pausing/i);
  assert.match(rounds.answer, /\{ad_pack_ld_round_days\}/);
  assert.match(audience.answer, /United Kingdom/);
  assert.match(audience.answer, /last checked/);
  for (const e of [calc, rounds, audience]) {
    assert.doesNotMatch(`${e.question} ${e.variants.join(' ')} ${e.answer}`, /!|\d|£/, e.slug);
    assert.deepEqual(e.channels, ['view', 'chat']);
  }
  assert.match(SERVICE_FACTS, /LEAD DATABASE AD PACKS/);
  assert.match(SERVICE_FACTS, /\{ad_calc_reports_per_day\}/);
  assert.match(SERVICE_FACTS, /\{ad_pack_ld_round_days\}/);
});

// Batch 55 step 2: the ad leads draft. A draft, no typed figure or price (the price setting comes in step 3).
test('the ad leads draft exists, says what is charged and what is not, and types no figure', async () => {
  const { SERVICE_FACTS } = await import('./service-facts.ts');
  const e = SEED.find((x) => x.slug === 'adpack_ld_ad_leads');
  assert.ok(e);
  assert.match(e.answer, /lead database/);
  assert.match(e.answer, /early estimate/);
  assert.match(e.answer, /separate lead/);
  assert.match(e.answer, /cannot be swapped or replaced/);
  assert.match(e.answer, /test/);
  assert.doesNotMatch(`${e.question} ${e.variants.join(' ')} ${e.answer}`, /!|\d|£/);
  assert.deepEqual(e.channels, ['view', 'chat']);
  assert.match(SERVICE_FACTS, /Ad leads \(lead database route\)/);
  assert.match(SERVICE_FACTS, /unpaid hold/);
});
