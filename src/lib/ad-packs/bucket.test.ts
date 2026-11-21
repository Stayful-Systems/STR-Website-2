import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { harness } from './test-store.ts';
import { adPacksBucketMimeTypes } from './render-test-store.ts';
import { MAX_POSTER_BYTES, MAX_VIDEO_BYTES, OUTPUTS, POSTER, SCRIPT_MIME, VOICE_MIME } from './render-core.ts';
import { checkPhoto } from './photos.ts';
import { VOICE_MIME_TYPE } from './voice-core.ts';

/**
 * Batch 38b: the private `ad-packs` bucket refuses a file whose content type is not in its allowed_mime_types
 * (supabase/schema.sql). The first real run failed because the cached voice (audio/mpeg) and its script
 * (application/json) were uploaded but not allowed. These tests pin the contract: every content type the ad-pack code
 * uploads is in that list, and a new upload type that the bucket would refuse fails here.
 */

const SCHEMA = readFileSync(path.join(process.cwd(), 'supabase', 'schema.sql'), 'utf8');
const ALLOWED = adPacksBucketMimeTypes(SCHEMA);
const OWNER = '3f9a2c11-1111-4111-8111-111111111111';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3, 4, 5, 6, 7]);

test('schema.sql creates the bucket once, private, and lists its allowed types', () => {
  assert.equal([...SCHEMA.matchAll(/insert into storage\.buckets[^;]*?'ad-packs'/g)].length, 1, 'one statement creates the ad-packs bucket');
  assert.ok(ALLOWED.length > 0, 'the allowed types could not be read from schema.sql');
  assert.equal(new Set(ALLOWED).size, ALLOWED.length, 'no type is listed twice');
  assert.match(SCHEMA, /values \('ad-packs', 'ad-packs', false,/);
  // The statement that fixes an existing database: a re-run puts the list back.
  assert.match(SCHEMA, /on conflict \(id\) do update[^;]*allowed_mime_types = excluded\.allowed_mime_types/);
});

test('the bucket allows what the worker uploads: the voice, its script, the three videos and the poster', () => {
  for (const t of [VOICE_MIME, SCRIPT_MIME, VOICE_MIME_TYPE, ...OUTPUTS.map((o) => o.contentType), POSTER.contentType]) {
    assert.ok(ALLOWED.includes(t), `${t} is uploaded by the render worker but the ad-packs bucket would refuse it`);
  }
  assert.equal(VOICE_MIME, 'audio/mpeg');
  assert.equal(SCRIPT_MIME, 'application/json');
});

test('no file the worker will upload is bigger than the bucket accepts', () => {
  const m = /values \('ad-packs', 'ad-packs', false, (\d+),/.exec(SCHEMA);
  assert.ok(m, 'the bucket size limit could not be read from schema.sql');
  const limit = Number(m![1]);
  assert.ok(MAX_VIDEO_BYTES <= limit, `a video up to ${MAX_VIDEO_BYTES} bytes is allowed by the worker but the bucket stops at ${limit}`);
  assert.ok(MAX_POSTER_BYTES <= limit);
});

test('the bucket allows every type a photo upload and the image cards use', async () => {
  const jpeg = checkPhoto(JPG, 'image/jpeg');
  const png = checkPhoto(PNG, 'image/png');
  assert.ok(jpeg.ok && png.ok);
  if (jpeg.ok) assert.ok(ALLOWED.includes(jpeg.contentType), jpeg.contentType);
  if (png.ok) assert.ok(ALLOWED.includes(png.contentType), png.contentType);

  // The generator's own uploads (the cards), as the generator makes them.
  const h = harness();
  const made = await h.engine.generatePack({
    ownerId: OWNER,
    by: 'operator',
    input: { areaKey: 'NG7', photos: [], brand: { company: 'Brightstone Stays', logoUrl: null, brandColour: '#1F6F5C', feePct: 12, areas: ['Nottingham'], photoUrl: null }, domain: 'brightstone.co.uk', websiteId: '00000000-0000-4000-8000-0000000000aa' },
  });
  assert.ok(made.ok);
  const types = new Set([...h.uploader.files.values()].map((f) => f.contentType));
  assert.ok(types.size > 0, 'the generator uploaded nothing');
  for (const t of types) assert.ok(ALLOWED.includes(t), `${t} is uploaded by the generator but the ad-packs bucket would refuse it`);
});

/** Source files (not tests, fixtures or test support) that can put something in the bucket. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'fixtures' || name === 'fonts' || name === 'node_modules') continue;
      out.push(...sourceFiles(p));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !/test-store|test-support/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Content-type-looking literals that appear in the ad-pack source but are NEVER uploaded to the bucket: a browser's
 * declared type that is normalised before storing, the sniffed types of a logo read from the web (a data URI for the
 * card, never stored), and the label of a stored file of unknown type that is only read. Adding a type to this list
 * needs a reason here; a type that IS uploaded belongs in schema.sql instead.
 */
const NEVER_UPLOADED: Record<string, string> = {
  'image/jpg': 'photos.ts: a browser may declare it; the stored type is image/jpeg',
  'image/svg+xml': 'images.tsx: a fetched logo as a data URI for the card',
  'image/gif': 'images.tsx: a fetched logo as a data URI for the card',
  'application/octet-stream': 'render-store.ts: the label of a stored reference with no type, only read',
};

test('no ad-pack source names a content type the bucket would refuse (a new upload type must be added to schema.sql)', () => {
  const roots = ['src/lib/ad-packs', 'src/app/leads/ads', 'src/app/admin/ad-packs', 'src/app/api/internal/ad-pack-renders', 'src/lib/email'].map((r) => path.join(process.cwd(), r));
  const found = new Map<string, string[]>();
  for (const root of roots) {
    const files = root.endsWith('email') ? readdirSync(root).filter((f) => /^ad-pack.*\.ts$/.test(f) && !/\.test\./.test(f)).map((f) => path.join(root, f)) : sourceFiles(root);
    for (const file of files) {
      for (const m of readFileSync(file, 'utf8').matchAll(/['"`]((?:image|video|audio|application|text|font)\/[a-z0-9.+-]+)['"`]/gi)) {
        const type = m[1].toLowerCase();
        found.set(type, [...(found.get(type) ?? []), path.relative(process.cwd(), file)]);
      }
    }
  }
  assert.ok(found.size > 0, 'the scan found no content type at all (the scan is broken)');
  const refused = [...found.entries()].filter(([type]) => !ALLOWED.includes(type) && !(type in NEVER_UPLOADED));
  assert.deepEqual(
    refused.map(([type, files]) => `${type} in ${[...new Set(files)].join(', ')}`),
    [],
    'a content type used by the ad-pack code is not in the ad-packs bucket allowed_mime_types (supabase/schema.sql): add it there (and to the live bucket), or list it in NEVER_UPLOADED with a reason',
  );
  // The allowlist does not rot: every entry is still in the source.
  for (const type of Object.keys(NEVER_UPLOADED)) assert.ok(found.has(type), `${type} is no longer used: drop it from NEVER_UPLOADED`);
});

test('the smoke test checks the same list on a built database', () => {
  const smoke = readFileSync(path.join(process.cwd(), 'supabase', 'tests', 'adpacks-smoke.sql'), 'utf8');
  for (const t of ['audio/mpeg', 'application/json', 'video/mp4', 'image/png', 'image/jpeg']) assert.ok(smoke.includes(`'${t}'`), `${t} missing from supabase/tests/adpacks-smoke.sql`);
});
