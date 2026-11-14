/**
 * Google Places API (New) — fetches nearby amenities by category.
 *
 * Batch 29: results are cached by location and type (places_cache_days, 90 by
 * default) in broker_cache under PLACES_QUESTION. The key is the type and the
 * point rounded to 3 decimal places (about 111m × 69m in the UK): the key the
 * meter already logs. The raw places are stored, and every distance is worked
 * out again from the property itself, with the same filters, so the same
 * property's report is identical. A cached read is logged as a free call
 * (unit places_nearby_cached, cache_hit), the way Airbtics' cached report read
 * is; the member's price is per report and does not change.
 */

import type { DemandDrivers, NearbyAmenity } from '../types';
import { meter } from '../credit/meter.ts';
import { hasServiceRole } from '../credit/db.ts';
import { getBillingSettings } from '../credit/unit-costs.ts';

export const PLACES_QUESTION = 'placesNearby';

/** The cache key: the type and the point to 3 decimal places. */
export function placesCacheKey(includedType: string, lat: number, lng: number): string {
  return `${includedType}|${lat.toFixed(3)},${lng.toFixed(3)}`;
}

/** Where the raw places are kept between reports (injected in tests). */
export interface PlacesCache {
  get(key: string): Promise<PlaceResult[] | null>;
  set(key: string, places: PlaceResult[]): Promise<void>;
}

export const NO_PLACES_CACHE: PlacesCache = { get: async () => null, set: async () => {} };

/** broker_cache, for places_cache_days (0: off, and off without a database). */
async function defaultPlacesCache(): Promise<PlacesCache> {
  if (!hasServiceRole()) return NO_PLACES_CACHE;
  const days = (await getBillingSettings()).lifecycle.placesCacheDays;
  if (!(days > 0)) return NO_PLACES_CACHE;
  const { brokerStore } = await import('../broker/store');
  const store = brokerStore();
  return {
    async get(key) {
      const a = await store.get<PlaceResult[]>(PLACES_QUESTION, key);
      if (!a || !Array.isArray(a.value) || !(Date.parse(a.expiresAt) > Date.now())) return null;
      return a.value;
    },
    async set(key, places) {
      const now = new Date();
      await store.set(PLACES_QUESTION, key, { value: places, provider: 'google', level: 3, fetchedAt: now.toISOString(), expiresAt: new Date(now.getTime() + days * 86_400_000).toISOString() });
    },
  };
}

/** Batch 21 (G7): give up before the report's 60 s kill, so the refund path runs. */
const PLACES_TIMEOUT_MS = 8_000;

const SEARCH_RADIUS = 5000; // metres
const AIRPORT_SEARCH_RADIUS = 50_000; // metres — real airports are further away
const MAX_RESULTS_TRANSPORT = 5;
const MAX_RESULTS_INSTITUTIONS = 10; // fetch more, then filter to quality results

const FIELD_MASK = [
  'places.displayName',
  'places.formattedAddress',
  'places.types',
  'places.rating',
  'places.location',
].join(',');

export interface PlaceResult {
  displayName?: { text?: string };
  formattedAddress?: string;
  types?: string[];
  rating?: number;
  location?: { latitude?: number; longitude?: number };
}

/**
 * Calculates distance in km between two lat/lng points using the Haversine formula.
 */
function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 100) / 100;
}

async function searchNearbyByType(
  lat: number,
  lng: number,
  includedType: string,
  apiKey: string,
  cache: PlacesCache = NO_PLACES_CACHE,
): Promise<NearbyAmenity[]> {
  const cacheKey = placesCacheKey(includedType, lat, lng);
  const cached = await cache.get(cacheKey).catch(() => null);
  if (cached) {
    // A free read of what an earlier report paid for: logged, never charged.
    const places = await meter({ provider: 'google', unit: 'places_nearby_cached', key: cacheKey, cacheHit: () => true }, async () => cached);
    return amenitiesFromPlaces(places, includedType, lat, lng);
  }
  const radius = includedType === 'airport' ? AIRPORT_SEARCH_RADIUS
    : includedType === 'hospital' ? 15_000  // 15km — major hospitals may be further
    : SEARCH_RADIUS;

  // Fetch more for hospitals/universities so we can filter to quality results
  const isInstitution = includedType === 'hospital' || includedType === 'university';
  const maxResults = isInstitution ? MAX_RESULTS_INSTITUTIONS : MAX_RESULTS_TRANSPORT;

  const body = {
    includedTypes: [includedType],
    maxResultCount: maxResults,
    locationRestriction: {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius,
      },
    },
  };

  const response = await meter(
    { provider: 'google', unit: 'places_nearby', key: cacheKey, failed: (r) => !r.ok },
    () =>
      fetch('https://places.googleapis.com/v1/places:searchNearby', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': FIELD_MASK,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(PLACES_TIMEOUT_MS),
      }),
  );

  if (!response.ok) {
    console.error(
      `Google Places search for "${includedType}" returned HTTP ${response.status}`,
    );
    return [];
  }

  const data = await response.json();
  const places: PlaceResult[] = data.places ?? [];
  await cache.set(cacheKey, places).catch((err) => console.warn('[places] cache write failed:', err instanceof Error ? err.message : String(err)));
  return amenitiesFromPlaces(places, includedType, lat, lng);
}

/**
 * The amenities a Places answer gives for a property: each one's distance from
 * the property itself, then the per-type filters (no helipads for airports;
 * major hospitals only; one entry per university). The same for a fresh
 * answer and a cached one.
 */
export function amenitiesFromPlaces(places: readonly PlaceResult[], includedType: string, lat: number, lng: number): NearbyAmenity[] {
  const amenities = places.map((place) => {
    const placeLat = place.location?.latitude ?? lat;
    const placeLng = place.location?.longitude ?? lng;

    return {
      name: place.displayName?.text ?? 'Unknown',
      type: includedType,
      address: place.formattedAddress ?? '',
      distance: haversineKm(lat, lng, placeLat, placeLng),
      rating: place.rating ?? null,
    };
  });

  // Filter out hospital helipads from airport results
  if (includedType === 'airport') {
    return amenities.filter(
      (a) => !/helipad|heliport/i.test(a.name),
    );
  }

  // Filter hospitals: keep only MAJOR NHS/teaching hospitals
  // Exclude private hospitals (Nuffield, Spire, BMI, Bupa), mental health, walk-in centres
  if (includedType === 'hospital') {
    const excludePattern = /walk-in|clinic|health centre|gp |surgery|pharmacy|nuffield|spire|bmi |bupa|priory|private|mental|foss park|rehabilitation|care home|clifton park|outpatient/i;
    const majorPattern = /hospital|infirmary/i;
    const filtered = amenities.filter(
      (a) => majorPattern.test(a.name) && !excludePattern.test(a.name),
    );
    // If nothing passes the strict filter, relax to just "Hospital" keyword
    if (filtered.length === 0) {
      return amenities.filter((a) => majorPattern.test(a.name)).slice(0, 3);
    }
    return filtered.slice(0, 3);
  }

  // Filter universities: keep only actual universities, deduplicate by institution
  if (includedType === 'university') {
    const filtered = amenities.filter((a) => /university/i.test(a.name));

    // Deduplicate: extract the core university name
    // "King's Manor - University of York" → "university of york"
    // "University of York" → "university of york"
    // "Manchester Metropolitan University" → "manchester metropolitan university"
    const seen = new Set<string>();
    const deduped = filtered.filter((a) => {
      const name = a.name.toLowerCase();
      // Try to extract "University of X" or "X University" pattern
      const uniOfMatch = name.match(/university\s+of\s+[\w\s]+/);
      const xUniMatch = name.match(/[\w\s]+university/);
      const core = (uniOfMatch?.[0] ?? xUniMatch?.[0] ?? name).trim();
      if (seen.has(core)) return false;
      seen.add(core);
      return true;
    });
    return deduped.slice(0, 3);
  }

  return amenities;
}

export async function getNearbyAmenities(
  lat: number,
  lng: number,
  opts: { cache?: PlacesCache } = {},
): Promise<DemandDrivers> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_PLACES_API_KEY is not set in environment variables.');
  }

  const types = ['hospital', 'university', 'airport', 'train_station', 'bus_station', 'subway_station'] as const;
  const cache = opts.cache ?? (await defaultPlacesCache().catch(() => NO_PLACES_CACHE));

  const results = await Promise.allSettled(
    types.map((type) => searchNearbyByType(lat, lng, type, apiKey, cache)),
  );

  const extract = (result: PromiseSettledResult<NearbyAmenity[]>): NearbyAmenity[] => {
    if (result.status === 'fulfilled') return result.value;
    console.error('Places search failed:', result.reason);
    return [];
  };

  return {
    hospitals: extract(results[0]),
    universities: extract(results[1]),
    airports: extract(results[2]),
    trainStations: extract(results[3]),
    busStations: extract(results[4]),
    subwayStations: extract(results[5]),
  };
}
