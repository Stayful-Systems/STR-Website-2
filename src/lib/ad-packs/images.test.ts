import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { renderCards, type Card } from './angles.ts';
import { buildFigure } from './figures.ts';
import { pickTextColour } from './checks.ts';
import { loadImagesModule } from './images-test-support.ts';

/**
 * Batch 38 phase 5: the image cards. These render real PNGs through next/og
 * (Satori + Resvg) in plain Node, with no network: fetchImage is injected.
 * images.tsx has JSX, which Node cannot load, so images-test-support.ts bundles it first.
 */

const m = await loadImagesModule();

const AGG = { bedrooms: 3, sample_count: 14, avg_gross_revenue: 48_200, avg_net_revenue: 31_000, avg_occupancy: 71.4 };
const figure = buildFigure({ area_label: 'Cambridge', agg: AGG, feePct: 12, netIncludesFee: false });
const BRAND_COLOURS = ['#1F6F5C', '#C2410C', '#1E3A8A'];

function cardsOf(angle: '3a' | '17', company = 'Brightstone Stays', area = 'Cambridge', fee: number | null = 12): Card[] {
  return renderCards({ angle, brand: { company, area, bedrooms: 3, feePct: fee }, figure });
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function ihdr(png: Buffer): { width: number; height: number } {
  assert.deepEqual(png.subarray(0, 8), SIGNATURE, 'PNG signature');
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

const brand = { company: 'Brightstone Stays', brandColour: '#1F6F5C', logoUrl: null };
const hook = cardsOf('3a')[0];
const figureCard = cardsOf('3a').find((c) => c.figure)!;

// ── Rendering ──

test('every size renders a PNG at exactly its width and height', async () => {
  const want = { '1x1': [1080, 1080], '4x5': [1080, 1350], '9x16': [1080, 1920] } as const;
  for (const size of m.CARD_SIZES) {
    const png = await m.renderCardPng({ card: hook, brand, photoUrl: null, size });
    const { width, height } = ihdr(png);
    assert.deepEqual([width, height], want[size], size);
  }
});

test('all cards of 3a and 17 render at every size, with the figure card in the set', async () => {
  for (const angle of ['3a', '17'] as const) {
    const cards = cardsOf(angle);
    assert.ok(cards.some((c) => c.figure), `${angle} has a figure card`);
    const images = await m.renderAdImages({ angle, cards, brand, photos: { pack: [], site: null } });
    assert.equal(images.length, cards.length * 3);
    for (const img of images) {
      const d = ihdr(img.png);
      assert.deepEqual([d.width, d.height], [img.width, img.height], img.name);
      assert.match(img.name, new RegExp(`^${angle}-card\\d+-(1x1|4x5|9x16)\\.png$`));
    }
    assert.ok(images.some((i) => i.name === `${angle}-card3-4x5.png`));
  }
});

test('brand colours and long names render at every size', async () => {
  const long = cardsOf('17', 'Oakridge Property Lettings and Management', 'Newcastle upon Tyne and Gateshead');
  for (const colour of BRAND_COLOURS) {
    for (const size of m.CARD_SIZES) {
      for (const card of long) {
        const png = await m.renderCardPng({ card, brand: { company: 'Oakridge Property Lettings and Management', brandColour: colour, logoUrl: null }, photoUrl: null, size });
        assert.equal(ihdr(png).width, 1080);
      }
    }
  }
});

test('a brand without a logo renders (company name only), and a missing colour falls back', async () => {
  const png = await m.renderCardPng({ card: hook, brand: { company: 'No Logo Lets', brandColour: null, logoUrl: null }, photoUrl: null, size: '4x5' });
  assert.deepEqual(ihdr(png), { width: 1080, height: 1350 });
});

test('type-only fallback: a fetchImage that throws still gives a card, for photo and logo', async () => {
  let calls = 0;
  const fetchImage = async () => {
    calls += 1;
    throw new Error('network down');
  };
  const png = await m.renderCardPng({
    card: hook,
    brand: { ...brand, logoUrl: 'https://example.com/logo.png' },
    photoUrl: 'https://example.com/photo.jpg',
    size: '9x16',
    fetchImage,
  });
  assert.deepEqual(ihdr(png), { width: 1080, height: 1920 });
  assert.ok(calls >= 1, 'it tried to fetch');
  const all = await m.renderAdImages({
    angle: '3a',
    cards: cardsOf('3a'),
    brand: { ...brand, logoUrl: 'https://example.com/logo.png' },
    photos: { pack: ['https://example.com/a.jpg', 'https://example.com/b.jpg'], site: 'https://example.com/site.jpg' },
    fetchImage,
    sizes: ['1x1'],
  });
  assert.equal(all.length, cardsOf('3a').length);
});

test('a photo is used when it fetches, and the card differs from the type-only one', async () => {
  const typeOnly = await m.renderCardPng({ card: hook, brand, photoUrl: null, size: '1x1' });
  // Any valid PNG is a stand-in for a photo: a rendered card, from a different colour.
  const stand = await m.renderCardPng({ card: cardsOf('17')[1], brand: { ...brand, brandColour: '#FACC15' }, photoUrl: null, size: '1x1' });
  const asked: string[] = [];
  const withPhoto = await m.renderCardPng({
    card: hook,
    brand,
    photoUrl: 'https://example.com/photo.png',
    size: '1x1',
    fetchImage: async (url) => {
      asked.push(url);
      return { bytes: stand, contentType: 'image/png' };
    },
  });
  assert.deepEqual(asked, ['https://example.com/photo.png']);
  ihdr(withPhoto);
  assert.notDeepEqual(withPhoto, typeOnly);
});

test('a figure card is never drawn on a photo (it asks for none)', async () => {
  const asked: string[] = [];
  await m.renderCardPng({
    card: figureCard,
    brand,
    photoUrl: 'https://example.com/photo.png',
    size: '4x5',
    fetchImage: async (url) => {
      asked.push(url);
      throw new Error('no');
    },
  });
  assert.deepEqual(asked, [], 'the figure card does not fetch the photo');
});

test('a corrupt or unsupported image falls back to type only instead of failing the card', async () => {
  const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const png = await m.renderCardPng({ card: hook, brand, photoUrl: 'https://example.com/x.jpg', size: '1x1', fetchImage: async () => ({ bytes: garbage }) });
  ihdr(png);
  // Looks like a PNG (so it is accepted) but is truncated: Satori may throw, and the card is retried without images.
  const truncated = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 4, 0, 0, 0, 4, 0]);
  const png2 = await m.renderCardPng({ card: hook, brand, photoUrl: 'https://example.com/x.png', size: '1x1', fetchImage: async () => ({ bytes: truncated }) });
  ihdr(png2);
});

test('photo candidates: pack photos first (rotating), then the site photo, then nothing', () => {
  const photos = { pack: ['p1', 'p2'], site: 's' };
  assert.deepEqual(m.photoCandidates(photos, 0), ['p1', 'p2', 's']);
  assert.deepEqual(m.photoCandidates(photos, 1), ['p2', 'p1', 's']);
  assert.deepEqual(m.photoCandidates(photos, 2), ['p1', 'p2', 's']);
  assert.deepEqual(m.photoCandidates({ pack: [], site: 's' }, 3), ['s']);
  assert.deepEqual(m.photoCandidates({ pack: [], site: null }, 0), []);
  assert.deepEqual(m.photoCandidates({ pack: [' ', ''], site: '' }, 0), []);
});

test('image names are 3a-card1-4x5.png style', () => {
  assert.equal(m.imageName('3a', 1, '4x5'), '3a-card1-4x5.png');
  assert.equal(m.imageName('17', 5, '9x16'), '17-card5-9x16.png');
});

// ── Pure helpers ──

test('deriveTints is pure, deterministic and keeps one hue family', () => {
  const a = m.deriveTints('#1F6F5C');
  const b = m.deriveTints('#1f6f5c');
  assert.deepEqual(a, b);
  assert.deepEqual(a, m.deriveTints('#1F6F5C'));
  assert.equal(a.base, '#1f6f5c');
  for (const k of ['base', 'dark', 'deep', 'mid', 'light'] as const) assert.match(a[k], /^#[0-9a-f]{6}$/);
  // dark and deep are darker than the base, light and mid are lighter.
  const lum = (h: string) => parseInt(h.slice(1, 3), 16) + parseInt(h.slice(3, 5), 16) + parseInt(h.slice(5, 7), 16);
  assert.ok(lum(a.deep) < lum(a.dark) && lum(a.dark) < lum(a.base) && lum(a.base) < lum(a.mid) && lum(a.mid) < lum(a.light));
  // short hex, no hash, and rubbish all resolve to something valid; rubbish is the default.
  assert.equal(m.deriveTints('#fff').base, '#ffffff');
  assert.equal(m.deriveTints('1F6F5C').base, '#1f6f5c');
  assert.equal(m.deriveTints('not a colour').base, m.deriveTints(m.DEFAULT_BRAND_COLOUR).base);
  assert.equal(m.deriveTints(null).base, m.deriveTints(undefined).base);
});

test('type colour comes from pickTextColour, and is readable on every sample colour', () => {
  for (const c of [...BRAND_COLOURS, '#FACC15', '#ffffff', '#000000']) {
    assert.equal(m.paletteFor(c).text, pickTextColour(m.deriveTints(c).base));
  }
  assert.equal(m.paletteFor('#FACC15').text, '#111111');
  assert.equal(m.paletteFor('#1E3A8A').text, '#ffffff');
});

test('safe areas: nothing in the top 14% and bottom 20% of 9:16, nor the bottom 10% of 4:5', () => {
  const s = m.layoutFor('9x16');
  assert.ok(s.insetTop >= 0.14 * 1920);
  assert.ok(s.insetBottom >= 0.2 * 1920);
  const p = m.layoutFor('4x5');
  assert.ok(p.insetBottom >= 0.1 * 1350);
  for (const size of m.CARD_SIZES) {
    const l = m.layoutFor(size);
    assert.equal(l.insetTop + l.boxHeight + l.insetBottom, l.height);
    assert.equal(l.padX * 2 + l.boxWidth, l.width);
  }
});

test('the type plan fits the safe box for every card, size and name length, never under the minimum size', () => {
  const companies = ['Kestrel Homes', 'Oakridge Property Lettings and Management', 'A'.repeat(80)];
  const areas = ['York', 'Newcastle upon Tyne and Gateshead'];
  for (const angle of ['3a', '17'] as const) {
    for (const company of companies) {
      for (const area of areas) {
        for (const fee of [12, null]) {
          const cards = renderCards({
            angle,
            brand: { company, area, bedrooms: 3, feePct: fee },
            figure: buildFigure({ area_label: area, agg: AGG, feePct: fee, netIncludesFee: false }),
          });
          for (const card of cards) {
            for (const size of m.CARD_SIZES) {
              const plan = m.planCard(card, m.cleanCompany(company), size, true, 200);
              assert.ok(plan.fits, `${angle} ${card.id} ${size} ${company.slice(0, 12)} fits`);
              for (const b of plan.body) assert.ok(b.fontSize >= m.MIN_BODY_PX);
              if (plan.label) assert.ok(plan.label.fontSize >= m.MIN_LABEL_PX, 'label is legible');
              assert.ok(plan.company.fontSize >= 30);
            }
          }
        }
      }
    }
  }
});

test('fitText steps down until the text fits and reports when it cannot', () => {
  const big = m.fitText({ text: 'short', boxWidth: 900, maxHeight: 400, max: 100, min: 40, lineHeight: 1, advance: 0.5 });
  assert.equal(big.fontSize, 100);
  assert.equal(big.fits, true);
  const tight = m.fitText({ text: 'word '.repeat(60), boxWidth: 400, maxHeight: 200, max: 100, min: 40, lineHeight: 1.2, advance: 0.5 });
  assert.equal(tight.fits, false);
  assert.equal(tight.fontSize, 40);
});

test('cleanText strips emoji and control characters (Satori would fetch emoji over the network)', () => {
  assert.equal(m.cleanText('Sunny \u{1F31E} Lets\u0000  '), 'Sunny Lets');
  assert.equal(m.cleanCompany('x'.repeat(200)).length, 80);
  assert.deepEqual(m.bigParts('£2,350 a month'), { amount: '£2,350', unit: 'a month' });
  assert.deepEqual(m.bigParts('£2,350'), { amount: '£2,350', unit: '' });
});

test('sniffImage trusts bytes, not content type; WebP is not drawn; sizes are read', () => {
  assert.equal(m.sniffImage(SIGNATURE), 'png');
  assert.equal(m.sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
  assert.equal(m.sniffImage(new TextEncoder().encode('RIFF....WEBPVP8 ')), null);
  assert.equal(m.sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'svg');
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80"></svg>');
  assert.deepEqual(m.imageSize(svg, 'svg'), { width: 200, height: 80 });
});

test('only public https image URLs are fetched', () => {
  assert.equal(m.isFetchableImageUrl('https://abc.supabase.co/storage/v1/object/public/x.jpg'), true);
  for (const bad of ['http://example.com/x.jpg', 'https://localhost/x', 'https://127.0.0.1/x', 'https://169.254.169.254/x', 'https://[::1]/x', 'file:///etc/passwd', 'nonsense', 'https://db.internal/x']) {
    assert.equal(m.isFetchableImageUrl(bad), false, bad);
  }
});

// ── Files ──

test('the fonts ship with their licence, and nothing here names the source brand', () => {
  const dir = new URL('./fonts/', import.meta.url);
  const files = readdirSync(dir).sort();
  assert.deepEqual(files, ['Anton-Regular.ttf', 'Archivo-Medium.ttf', 'Archivo-SemiBold.ttf', 'OFL.txt']);
  assert.match(readFileSync(new URL('OFL.txt', dir), 'utf8'), /SIL OPEN FONT LICENSE Version 1\.1|SIL OPEN FONT LICENSE\s+Version 1\.1/i);
  const brandWord = new RegExp('stay' + 'ful', 'i');
  for (const f of ['images.tsx', 'images.test.ts', 'images-test-support.ts']) {
    assert.doesNotMatch(readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'), brandWord, f);
  }
  assert.doesNotMatch(readFileSync(new URL('OFL.txt', dir), 'utf8'), brandWord);
});
