import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidates, slugFromCompany, townPart, validCoUk } from './name.ts';

test('"Harbour Management Ltd" becomes harbourmanagement.co.uk, not ...managementmanagement', () => {
  assert.equal(slugFromCompany('Harbour Management Ltd'), 'harbour');
  assert.equal(candidates('Harbour Management Ltd')[0], 'harbourmanagement.co.uk');
  assert.equal(candidates('HarbourManagement')[0], 'harbourmanagement.co.uk');
  assert.equal(candidates('Harbour')[0], 'harbourmanagement.co.uk');
});

test('Ltd, Limited, LLP, PLC and & are stripped; punctuation and accents vanish', () => {
  assert.equal(slugFromCompany('Smith & Jones Ltd'), 'smithjones');
  assert.equal(slugFromCompany('Smith&Jones Limited'), 'smithjones');
  assert.equal(slugFromCompany('Oak LLP'), 'oak');
  assert.equal(slugFromCompany('Oak Lettings PLC'), 'oak');
  assert.equal(slugFromCompany('Oak Lettings Management Ltd'), 'oak');
  assert.equal(candidates('Oak Lettings Ltd')[0], 'oakmanagement.co.uk');
  assert.equal(slugFromCompany("O'Neil Properties"), 'oneilproperties');
  assert.equal(slugFromCompany('Café Résidences'), 'caferesidences');
  assert.equal(slugFromCompany('  The   Old  Mill  '), 'theoldmill');
});

test('"management" alone, or nothing usable, gives no names', () => {
  assert.equal(slugFromCompany('Management Ltd'), '');
  assert.deepEqual(candidates('Management'), []);
  assert.deepEqual(candidates('Lettings Ltd'), []);
  assert.deepEqual(candidates(''), []);
  assert.deepEqual(candidates(null), []);
  assert.deepEqual(candidates('!!! & ???'), []);
  assert.equal(slugFromCompany(undefined), '');
});

test('up to five alternatives follow the primary, in order, all valid and distinct', () => {
  const names = candidates('Harbour Management Ltd', ['Leeds', 'York']);
  assert.deepEqual(names, [
    'harbourmanagement.co.uk',
    'harbour-management.co.uk',
    'harbourleedsmanagement.co.uk',
    'harbourlettings.co.uk',
    'harbour-lettings.co.uk',
    'harbourleedslettings.co.uk',
  ]);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.every(validCoUk));
  assert.ok(names.length <= 6);
});

test('with no town, the two town names are left out', () => {
  assert.deepEqual(candidates('Harbour', []), ['harbourmanagement.co.uk', 'harbour-management.co.uk', 'harbourlettings.co.uk', 'harbour-lettings.co.uk']);
  assert.deepEqual(candidates('Harbour', ['', '  ', 42, null]), candidates('Harbour', []));
  assert.equal(townPart('St. Albans'), 'stalbans');
});

test('a very long name is cut to fit a 63 character label', () => {
  const names = candidates('A'.repeat(200), ['Wolverhampton-upon-something']);
  assert.ok(names.length > 0);
  for (const n of names) {
    assert.ok(validCoUk(n), n);
    assert.ok(n.slice(0, -'.co.uk'.length).length <= 63, n);
  }
});

test('validCoUk: one plain label under .co.uk, nothing else', () => {
  for (const ok of ['a.co.uk', 'harbour.co.uk', 'harbour-management.co.uk', '1a.co.uk', `${'a'.repeat(63)}.co.uk`]) assert.equal(validCoUk(ok), true, ok);
  for (const bad of [
    '', 'harbour.com', 'harbour.uk', 'harbour.org.uk', 'co.uk', '.co.uk', 'www.harbour.co.uk', 'a.b.co.uk',
    '-harbour.co.uk', 'harbour-.co.uk', 'Harbour.co.uk', 'har bour.co.uk', 'harbour_x.co.uk', `${'a'.repeat(64)}.co.uk`,
    'xn--bcher-kva.co.uk', 'ab--cd.co.uk', 'harbour.co.uk/', 'harbour.co.uk.evil.com', 'evil.com/.co.uk', 'harbour.co.uk\n',
    'haçbour.co.uk',
  ]) assert.equal(validCoUk(bad), false, JSON.stringify(bad));
  assert.equal(validCoUk(undefined), false);
  assert.equal(validCoUk(42), false);
});

test('brands are never offered: airbnb, vrbo and stayful anywhere, booking at the start', () => {
  for (const bad of ['airbnbmanagement.co.uk', 'myairbnbhost.co.uk', 'vrbo-lettings.co.uk', 'stayfulmanagement.co.uk', 'bookingmanagement.co.uk', 'booking-lettings.co.uk', 'rightmovehomes.co.uk']) assert.equal(validCoUk(bad), false, bad);
  assert.equal(validCoUk('harbourbookings.co.uk'), true, 'booking is only blocked at the start');
  assert.deepEqual(candidates('Airbnb Hosts Ltd'), []);
  assert.deepEqual(candidates('Stayful'), []);
});
