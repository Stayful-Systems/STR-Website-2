import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headersChanged, hashHeaders, mapHeaders, normaliseHeader } from './headers.ts';
import {
  ROW_KEY_MAX,
  findCodeInText,
  isComplete,
  isTestLead,
  normalisePhone,
  normalisePostcode,
  rowKey,
  toCandidate,
} from './rows.ts';
import {
  FIXTURE_HEADERS,
  FIXTURE_ROW_INCOMPLETE,
  FIXTURE_ROW_PACK,
  FIXTURE_ROW_PLAIN,
  FIXTURE_ROW_TEST,
} from './fixtures.ts';

test('header normalisation drops case, punctuation, underscores and spaces', () => {
  assert.equal(normaliseHeader('Post_Code?'), 'postcode');
  assert.equal(normaliseHeader(' What is the postcode of your property? '), 'whatisthepostcodeofyourproperty');
});

test('the Meta layout maps every field, the questions stay unknown', () => {
  const hm = mapHeaders(FIXTURE_HEADERS);
  assert.deepEqual(hm.map.lead_id, [0]);
  assert.deepEqual(hm.map.ad_name, [3]);
  assert.deepEqual(hm.map.name, [14]);
  assert.deepEqual(hm.map.email, [15]);
  assert.deepEqual(hm.map.phone, [16]);
  assert.deepEqual(hm.map.postcode, [17]);
  assert.deepEqual(hm.missingRequired, []);
  assert.deepEqual(
    hm.unknown.map((u) => u.header),
    ['how_many_properties_do_you_own?', 'are_you_thinking_of_moving_to_short_lets?'],
  );
});

test('header variants map to the same field', () => {
  const cases: [string, string][] = [
    ['Your Name', 'name'],
    ['full_name', 'name'],
    ['Phone', 'phone'],
    ['Mobile', 'phone'],
    ['Telephone', 'phone'],
    ['phone_number', 'phone'],
    ['Post Code', 'postcode'],
    ['postal_code', 'postcode'],
    ['ZIP code', 'postcode'],
    ['Property postcode', 'postcode'],
    ['What is the postcode of your property?', 'postcode'],
    ['Email Address', 'email'],
    ['leadgen_id', 'lead_id'],
    ['Lead ID', 'lead_id'],
    ['Created Time', 'created_time'],
    ['Ad ID', 'ad_id'],
    ['Ad Name', 'ad_name'],
    ['Is Organic', 'is_organic'],
    ['Platform', 'platform'],
    ['Campaign Name', 'campaign_name'],
    ['AdSet Name', 'adset_name'],
    ['form_name', 'form_name'],
    ['form_id', 'form_id'],
  ];
  for (const [header, field] of cases) {
    const hm = mapHeaders(['zzz question', header]);
    assert.deepEqual(hm.map[field as keyof typeof hm.map], [1], `${header} -> ${field}`);
  }
});

test('a long question header that says postcode still counts when no exact column does', () => {
  const hm = mapHeaders(['full_name', 'phone', 'Postcode of the property you want to let out?']);
  assert.deepEqual(hm.map.postcode, [2]);
  assert.deepEqual(hm.missingRequired, []);
});

test('first and last name join into one name', () => {
  const hm = mapHeaders(['first_name', 'last_name', 'email', 'post_code']);
  assert.deepEqual(hm.missingRequired, []);
  const c = toCandidate(['  Alex ', 'Example', 'a@example.com', 'M1 1AE'], hm);
  assert.equal(c.name, 'Alex Example');
});

test('missingRequired lists a required field that has no column', () => {
  assert.deepEqual(mapHeaders(['full_name', 'email']).missingRequired, ['postcode']);
  assert.deepEqual(mapHeaders(['email', 'post_code']).missingRequired, ['name']);
  assert.deepEqual(mapHeaders(['full_name', 'post_code']).missingRequired, ['phone_or_email']);
  assert.deepEqual(mapHeaders(['full_name', 'phone', 'post_code']).missingRequired, []);
  assert.deepEqual(mapHeaders(['a', 'b']).missingRequired, ['name', 'phone_or_email', 'postcode']);
});

test('the header hash is stable, ignores case, punctuation and trailing blanks, and moves on a real change', () => {
  const a = hashHeaders(FIXTURE_HEADERS);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(hashHeaders([...FIXTURE_HEADERS, '', ' ']), a);
  assert.equal(hashHeaders(FIXTURE_HEADERS.map((h) => h.toUpperCase().replace(/_/g, ' '))), a);
  assert.equal(mapHeaders(FIXTURE_HEADERS).hash, a);
  const b = hashHeaders(FIXTURE_HEADERS.filter((h) => h !== 'ad_name'));
  assert.notEqual(a, b);
  assert.equal(headersChanged(a, b), true);
  assert.equal(headersChanged(a, a), false);
  assert.equal(headersChanged(null, a), false);
});

test('a pack-ad row becomes a clean candidate with the questions as answers', () => {
  const hm = mapHeaders(FIXTURE_HEADERS);
  const c = toCandidate(FIXTURE_ROW_PACK, hm);
  assert.equal(c.name, 'Alex Example');
  assert.equal(c.email, 'alex.example@example.com');
  assert.equal(c.phone, '+447700900123');
  assert.equal(c.postcode, 'SW1A 1AA');
  assert.equal(c.adName, 'SI-3F9A2C-5B-1 · Tenant notice');
  assert.equal(c.adId, '120210000000000001');
  assert.equal(c.metaLeadId, '1001000000000001');
  assert.deepEqual(c.answers, {
    'how_many_properties_do_you_own?': '2 to 5',
    'are_you_thinking_of_moving_to_short_lets?': 'Yes, within 3 months',
  });
  assert.equal(c.test, false);
  assert.deepEqual(isComplete(c), { complete: true, missing: [] });
});

test('a row with no email is complete on phone alone', () => {
  const c = toCandidate(FIXTURE_ROW_PLAIN, mapHeaders(FIXTURE_HEADERS));
  assert.equal(c.email, null);
  assert.equal(c.phone, '+447700900456');
  assert.equal(c.postcode, 'M1 1AE');
  assert.equal(isComplete(c).complete, true);
});

test('an incomplete row is flagged with the right missing list', () => {
  const hm = mapHeaders(FIXTURE_HEADERS);
  const c = toCandidate(FIXTURE_ROW_INCOMPLETE, hm);
  assert.equal(c.email, 'jo.partial@example.com');
  assert.equal(c.phone, null);
  assert.equal(c.postcode, null);
  assert.deepEqual(isComplete(c), { complete: false, missing: ['postcode'] });
  assert.deepEqual(isComplete({ name: null, email: null, phone: null, postcode: 'M1 1AE' }), {
    complete: false,
    missing: ['name', 'phone_or_email'],
  });
  assert.deepEqual(isComplete({ name: null, email: null, phone: null, postcode: null }).missing, [
    'name',
    'phone_or_email',
    'postcode',
  ]);
});

test('Meta test leads are detected from the row and from the candidate', () => {
  const hm = mapHeaders(FIXTURE_HEADERS);
  assert.equal(isTestLead(FIXTURE_ROW_TEST), true);
  assert.equal(isTestLead(toCandidate(FIXTURE_ROW_TEST, hm)), true);
  assert.equal(isTestLead(FIXTURE_ROW_PACK), false);
  assert.equal(isTestLead(toCandidate(FIXTURE_ROW_PACK, hm)), false);
  assert.equal(isTestLead(['x', 'Test Lead', 'y']), true);
  assert.equal(isTestLead(['x', 'dummy data', 'y']), true);
  assert.equal(isTestLead(['x', 'Latest leader', 'y']), false);
});

test('the row key is the Meta lead id when there is one', () => {
  const hm = mapHeaders(FIXTURE_HEADERS);
  assert.equal(rowKey(FIXTURE_ROW_PACK, hm), 'id:1001000000000001');
  assert.equal(rowKey(FIXTURE_ROW_PACK, hm), rowKey([...FIXTURE_ROW_PACK], hm));
  assert.ok(rowKey(['l:' + '9'.repeat(200)], hm).length <= ROW_KEY_MAX);
});

test('without a lead id the row key is a stable hash that ignores trailing blanks', () => {
  const hm = mapHeaders(['full_name', 'email', 'phone', 'post_code']);
  const row = ['Alex Example', 'a@example.com', '07700 900123', 'M1 1AE'];
  const k = rowKey(row, hm);
  assert.match(k, /^h:[0-9a-f]{64}$/);
  assert.ok(k.length <= ROW_KEY_MAX);
  assert.equal(rowKey([...row, '', ' '], hm), k);
  assert.equal(rowKey(row.map((c) => `${c} `), hm), k);
  assert.notEqual(rowKey(['Someone Else', ...row.slice(1)], hm), k);
  // A blank lead id cell falls back to the hash too.
  const hm2 = mapHeaders(['id', 'full_name']);
  assert.match(rowKey(['', 'Alex'], hm2), /^h:/);
});

test('a pack code is found inside an ad name and normalised', () => {
  assert.equal(findCodeInText('SI-3F9A2C-5B-1 · Tenant notice'), 'SI-3F9A2C-5B-1');
  assert.equal(findCodeInText('Tenant notice (copy) si-3f9a2c-3a-12 v2'), 'SI-3F9A2C-3A-12');
  assert.equal(findCodeInText('SI–3F9A2C–17–4 | moving abroad'), 'SI-3F9A2C-17-4');
  assert.equal(findCodeInText('x SI-3F9A2C-5B-1'), 'SI-3F9A2C-5B-1');
});

test('text without a pack code gives null', () => {
  assert.equal(findCodeInText('Landlord video 2'), null);
  assert.equal(findCodeInText(''), null);
  assert.equal(findCodeInText(null), null);
  assert.equal(findCodeInText('SI-3F9A2C-9Z-1'), null);
  assert.equal(findCodeInText('XSI-3F9A2C-5B-1'), null);
  assert.equal(findCodeInText('SI-3F9A2C-5B-1a'), null);
  assert.equal(findCodeInText('SI-3F9A2C-5B-0'), null);
});

test('postcodes come out upper case with one space', () => {
  assert.equal(normalisePostcode('sw1a1aa'), 'SW1A 1AA');
  assert.equal(normalisePostcode('  m1   1ae '), 'M1 1AE');
  assert.equal(normalisePostcode('EH1 1YZ'), 'EH1 1YZ');
  assert.equal(normalisePostcode('not a postcode'), null);
  assert.equal(normalisePostcode(''), null);
});

test('phones come out in one +44 form, Meta prefix removed', () => {
  assert.equal(normalisePhone('p:+447700900123'), '+447700900123');
  assert.equal(normalisePhone('p:+44 7700 900123'), '+447700900123');
  assert.equal(normalisePhone('07700 900123'), '+447700900123');
  assert.equal(normalisePhone('+44 (0)7700 900123'), '+447700900123');
  assert.equal(normalisePhone('447700900123'), '+447700900123');
  assert.equal(normalisePhone('0044 7700 900123'), '+447700900123');
  assert.equal(normalisePhone('<test lead: dummy data for phone_number>'), null);
  assert.equal(normalisePhone(''), null);
});
