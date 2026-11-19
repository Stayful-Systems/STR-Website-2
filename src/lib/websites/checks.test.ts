import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXCERPT_MAX, bannedClaimHits, checkSite, checkText, excerpt, isEmail, isUkPhone, placeholderHits, stepOneDryRun, validateStepOne } from './checks.ts';
import { buildSitePages, type SiteCopy, type SiteSettings } from './page-model.ts';
import { SAMPLE_COPY, SAMPLE_SETTINGS, SAMPLE_SITE } from './sample-site.ts';

const OPTS = { managementFeePct: SAMPLE_SETTINGS.managementFeePct, brandColour: SAMPLE_SETTINGS.brandColour, logoUrl: SAMPLE_SETTINGS.logoUrl };

function run(settings: Partial<SiteSettings> = {}, copy: SiteCopy = SAMPLE_COPY) {
  const s = { ...SAMPLE_SETTINGS, ...settings };
  return checkSite(buildSitePages({ site: SAMPLE_SITE, settings: s, copy }), { managementFeePct: s.managementFeePct, brandColour: s.brandColour, logoUrl: s.logoUrl });
}

const withHome = (patch: Partial<SiteCopy['home']>): SiteCopy => ({ ...SAMPLE_COPY, home: { ...SAMPLE_COPY.home, ...patch } });

test('checks: a clean sample site passes', () => {
  const r = run();
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
});

test('checks block a site with placeholder text', () => {
  for (const bad of ['Welcome to {{company}}', 'Welcome to [Company]', 'Lorem ipsum dolor sit amet', 'TODO write this', 'Hello undefined']) {
    const r = run({}, withHome({ intro: bad }));
    assert.equal(r.ok, false, bad);
    const p = r.problems.find((x) => x.rule === 'placeholder');
    assert.ok(p, bad);
    assert.equal(p!.page, 'home');
    assert.equal(p!.field, 'section:intro.paragraph1');
  }
});

test('checks: placeholders are found in headings, faq answers, area copy and the company name', () => {
  assert.ok(run({}, withHome({ headline: 'Your [City] landlord' })).problems.some((p) => p.field === 'heading'));
  const faq = { ...SAMPLE_COPY, faq: { ...SAMPLE_COPY.faq, items: [{ question: 'Q?', answer: 'See {{link}}' }] } };
  assert.ok(run({}, faq).problems.some((p) => p.page === 'faq' && p.field === 'faq.1.answer' && p.rule === 'placeholder'));
  const area = { ...SAMPLE_COPY, areas: [{ ...SAMPLE_COPY.areas[0], body: 'lorem ipsum' }, SAMPLE_COPY.areas[1]] };
  assert.ok(run({}, area).problems.some((p) => p.page === 'areas/leeds' && p.rule === 'placeholder'));
  assert.ok(run({ companyName: '[Company]' }).problems.some((p) => p.page === 'site' && p.field === 'companyName' && p.rule === 'placeholder'));
});

test('checks: banned claims are caught', () => {
  const claims = [
    'We offer guaranteed income on every property.',
    'Your rent is guaranteed every month.',
    'There are no voids with us.',
    'Zero voids, ever.',
    'You will earn more with us.',
    "You'll earn a fortune.",
    'Landlords earn £3,000 a month.',
    'Expect £2,000-£3,000 per month.',
    'Typical income is £2,000 to £3,000 a month.',
    'Make £2k–£3k pcm.',
  ];
  for (const c of claims) {
    const r = run({}, withHome({ intro: c }));
    assert.ok(r.problems.some((p) => p.rule === 'banned_claim' && p.page === 'home'), c);
  }
});

test('checks: honest wording is not a banned claim', () => {
  for (const ok of [
    'We cannot guarantee any income, because bookings depend on the market.',
    'Income is not guaranteed.',
    'Our fee is 15% and there are no set-up charges.',
    'Rates start at £60 per night in busy weeks.',
    'We manage void periods carefully.',
  ]) {
    assert.deepEqual(bannedClaimHits(ok), [], ok);
  }
});

test('checks: bad phone and email are caught', () => {
  for (const phone of ['12345', 'call us', '+1 212 555 0100', '{{phone}}', '']) {
    const r = run({ contactPhone: phone });
    assert.ok(r.problems.some((p) => p.field === 'contactPhone' && (p.rule === 'phone' || p.rule === 'required' || p.rule === 'placeholder')), phone);
    assert.equal(r.ok, false);
  }
  for (const email of ['hello', 'hello@', 'a b@c.com', 'x@y', '']) {
    const r = run({ contactEmail: email });
    assert.ok(r.problems.some((p) => p.field === 'contactEmail' && (p.rule === 'email' || p.rule === 'required')), email);
    assert.equal(r.ok, false);
  }
});

test('checks: UK phone and email validators', () => {
  for (const ok of ['07700 900123', '+44 7700 900123', '0113 496 0123', '020 7946 0123', '0800 123 4567', '03000 123456']) assert.equal(isUkPhone(ok), true, ok);
  for (const bad of ['', '123', '+1 212 555 0100', 'abc', '0900 123 4567', '07700 9001']) assert.equal(isUkPhone(bad), false, bad);
  assert.equal(isEmail('a@b.co.uk'), true);
  assert.equal(isEmail('a@b'), false);
});

test('checks: required site and page fields', () => {
  assert.ok(run({ companyName: '' }).problems.some((p) => p.field === 'companyName' && p.rule === 'required'));
  assert.ok(run({ areas: [] }).problems.some((p) => p.field === 'areas'));
  assert.ok(run({ managementFeePct: null }).problems.some((p) => p.page === 'fees' && p.field === 'section:fee'));
  assert.ok(run({}, withHome({ headline: '' })).problems.some((p) => p.page === 'home' && p.field === 'heading' && p.rule === 'required'));
  assert.ok(run({}, { ...SAMPLE_COPY, faq: { headline: 'FAQ', items: [] } }).problems.some((p) => p.page === 'faq' && p.field === 'faq'));
  assert.ok(run({}, { ...SAMPLE_COPY, about: { headline: 'About', body: '' } }).problems.some((p) => p.page === 'about' && p.rule === 'required'));
  assert.equal(run({ brandColour: 'teal' }).problems.some((p) => p.field === 'brandColour' && p.rule === 'colour'), true);
  assert.equal(run({ logoUrl: 'https://x.example/logo.svg' }).problems.some((p) => p.field === 'logoUrl' && p.rule === 'logo'), true);
  assert.equal(run({ brandColour: null, logoUrl: null }).ok, true);
  assert.equal(checkSite([]).ok, false);
});

test('checks: a page that needs the lead form must have one', () => {
  const pages = buildSitePages({ site: SAMPLE_SITE, settings: SAMPLE_SETTINGS, copy: SAMPLE_COPY });
  const noForm = pages.map((p) => (p.key === 'fees' ? { ...p, form: null } : p));
  const r = checkSite(noForm, OPTS);
  assert.ok(r.problems.some((p) => p.rule === 'form' && p.page === 'fees'));
  assert.equal(checkSite(pages, OPTS).ok, true);
  // Privacy has no form and does not need one.
  assert.equal(checkSite(pages, OPTS).problems.some((p) => p.page === 'privacy'), false);
});

test('checks: the fee on the fees page must match the setting', () => {
  const pages = buildSitePages({ site: SAMPLE_SITE, settings: SAMPLE_SETTINGS, copy: SAMPLE_COPY });
  assert.ok(checkSite(pages, { ...OPTS, managementFeePct: 20 }).problems.some((p) => p.page === 'fees' && p.field === 'section:fee'));
});

test('checks: step-1 dry run runs the real validator on the form\'s own fields', () => {
  const pages = buildSitePages({ site: SAMPLE_SITE, settings: SAMPLE_SETTINGS, copy: SAMPLE_COPY });
  assert.deepEqual(stepOneDryRun(pages[0].form), { ok: true, problems: [] });

  const form = pages[0].form!;
  const noPhone = { ...form, fields: form.fields.filter((f) => f.name !== 'phone') };
  const r = stepOneDryRun(noPhone);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.field === 'form.phone'));

  assert.equal(stepOneDryRun({ ...form, consentText: '  ' }).ok, false);
  assert.equal(stepOneDryRun({ ...form, action: '/somewhere/else' }).ok, false);
  assert.equal(stepOneDryRun(null).ok, false);

  // And through checkSite: a form missing a field is a step1 problem.
  const broken = pages.map((p) => (p.form ? { ...p, form: { ...p.form, fields: p.form.fields.filter((f) => f.name !== 'email') } } : p));
  assert.ok(checkSite(broken, OPTS).problems.some((p) => p.rule === 'step1' && p.field === 'form.email'));
});

test('checks: validateStepOne', () => {
  const good = { name: 'Sam Jones', email: 'Sam@Gmail.com', phone: '07700 900123', consent: true };
  const ok = validateStepOne(good);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.clean.email, 'sam@gmail.com');
  const fields = (i: object) => {
    const r = validateStepOne(i);
    return r.ok ? [] : r.errors.map((e) => e.field);
  };
  assert.deepEqual(fields({ ...good, name: '' }), ['name']);
  assert.deepEqual(fields({ ...good, email: 'nope' }), ['email']);
  assert.deepEqual(fields({ ...good, email: 'x@mailinator.com' }), ['email']);
  assert.deepEqual(fields({ ...good, phone: '999' }), ['phone']);
  assert.deepEqual(fields({ ...good, consent: false }), ['consent']);
  assert.deepEqual(fields({ ...good, consent: 'true' }), ['consent']);
  assert.deepEqual(fields({}), ['name', 'email', 'phone', 'consent']);
  assert.deepEqual(fields(null as never), ['name', 'email', 'phone', 'consent']);
});

test('checks: problems never echo more than a short excerpt', () => {
  const long = `${'Lovely home. '.repeat(40)}TODO ${'and more words here '.repeat(40)}`;
  const r = run({}, withHome({ intro: long }));
  const p = r.problems.find((x) => x.rule === 'placeholder')!;
  assert.match(p.message, /TODO/);
  assert.ok(p.message.length < 100, p.message);
  const quoted = p.message.match(/"([^"]*)"/)![1];
  assert.ok(quoted.length <= EXCERPT_MAX);
  const claim = checkText('home', 'intro', `${'x '.repeat(100)}You will earn a fortune ${'y '.repeat(100)}`);
  assert.ok(claim.every((c) => (c.message.match(/"([^"]*)"/)?.[1].length ?? 0) <= EXCERPT_MAX));
  assert.ok(excerpt('a'.repeat(500), 100, 300).length <= EXCERPT_MAX);
  assert.equal(JSON.stringify(r.problems).includes('and more words here and more words here and more words here'), false);
});

test('checks: placeholder detection leaves normal punctuation alone', () => {
  assert.deepEqual(placeholderHits('Call us (0113) 496 0123 - we are open 9-5, Mon-Fri.'), []);
  assert.deepEqual(placeholderHits('Fees: 15% + no set-up charge.'), []);
  assert.equal(placeholderHits('[Company] and {{x}}').length, 2);
});
