import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amenitiesFromPlaces, getNearbyAmenities, placesAnswerKind, placesCacheDaysFor, placesCacheKey, type PlaceResult, type PlacesAnswerKind, type PlacesCache } from './google-places.ts';

function memoryCache(): PlacesCache & { size: () => number } {
  const m = new Map<string, PlaceResult[]>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v), size: () => m.size };
}

const PLACES: Record<string, PlaceResult[]> = {
  train_station: [{ displayName: { text: 'Leeds' }, formattedAddress: 'New Station St', location: { latitude: 53.7949, longitude: -1.5474 }, rating: 4.1 }],
  hospital: [{ displayName: { text: 'Leeds General Infirmary' }, formattedAddress: 'Great George St', location: { latitude: 53.8016, longitude: -1.5524 } }],
};

function fakeFetch(calls: string[]): typeof fetch {
  return (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { includedTypes?: string[] };
    const type = body.includedTypes?.[0] ?? '';
    calls.push(type);
    return new Response(JSON.stringify({ places: PLACES[type] ?? [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

test('places cache: a miss asks Google and keeps the answer; the same street again asks nothing, and the report is identical', async () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.GOOGLE_PLACES_API_KEY;
  process.env.GOOGLE_PLACES_API_KEY = 'test-key';
  const calls: string[] = [];
  globalThis.fetch = fakeFetch(calls);
  try {
    const cache = memoryCache();
    const first = await getNearbyAmenities(53.8008, -1.5491, { cache });
    assert.equal(calls.length, 6, 'one search per type on a miss');
    assert.equal(cache.size(), 6);
    const again = await getNearbyAmenities(53.8008, -1.5491, { cache });
    assert.equal(calls.length, 6, 'a hit asks Google nothing');
    assert.deepEqual(again, first, 'the same property gets the same figures and sections');
    // A neighbour in the same ~100m cell: the cached places, distances from where they are.
    const near = await getNearbyAmenities(53.8006, -1.5494, { cache });
    assert.equal(calls.length, 6);
    assert.equal(near.trainStations[0].name, 'Leeds');
    assert.notEqual(near.trainStations[0].distance, undefined);
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
    else process.env.GOOGLE_PLACES_API_KEY = realKey;
  }
});

test('the key is the type and the point to 3 decimal places (about 100m)', () => {
  assert.equal(placesCacheKey('hospital', 53.80081, -1.54912), 'hospital|53.801,-1.549');
  assert.equal(placesCacheKey('hospital', 53.80049, -1.54941), 'hospital|53.800,-1.549');
});

test('distances are worked out from the property, not the cached search', () => {
  const at = amenitiesFromPlaces(PLACES.train_station, 'train_station', 53.7949, -1.5474);
  assert.equal(at[0].distance, 0);
  const away = amenitiesFromPlaces(PLACES.train_station, 'train_station', 53.8039, -1.5474);
  assert.ok(away[0].distance > 0.9 && away[0].distance < 1.1, String(away[0].distance));
});

test('Review R4 (R4-20): an empty answer is cached with the short time, a full one with the long time', async () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.GOOGLE_PLACES_API_KEY;
  process.env.GOOGLE_PLACES_API_KEY = 'test-key';
  globalThis.fetch = fakeFetch([]);
  try {
    const kinds = new Map<string, PlacesAnswerKind | undefined>();
    const cache: PlacesCache = { get: async () => null, set: async (k, _v, kind) => void kinds.set(k.split('|')[0], kind) };
    await getNearbyAmenities(53.8008, -1.5491, { cache });
    assert.equal(kinds.get('airport'), 'empty', 'no airport in range: kept, but only for the short time');
    assert.equal(kinds.get('subway_station'), 'empty');
    assert.equal(kinds.get('train_station'), 'places');
    assert.equal(kinds.get('hospital'), 'places');
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
    else process.env.GOOGLE_PLACES_API_KEY = realKey;
  }
  const days = { placesCacheDays: 90, placesCacheEmptyDays: 3 };
  assert.equal(placesAnswerKind([]), 'empty');
  assert.equal(placesCacheDaysFor('empty', days), 3);
  assert.equal(placesCacheDaysFor('places', days), 90);
  assert.equal(placesCacheDaysFor('empty', { placesCacheDays: 2, placesCacheEmptyDays: 3 }), 2, 'never longer than a full answer');
  assert.equal(placesCacheDaysFor('empty', { placesCacheDays: 90, placesCacheEmptyDays: 0 }), 0, '0: an empty answer is not kept');
});
