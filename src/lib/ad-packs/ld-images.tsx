/**
 * Batch 55 step 5 (Phase 2, 55c A2 and A3): the lead database route's pictures, drawn with next/og's ImageResponse
 * (Satori + Resvg) like the batch 38 cards (images.tsx, unchanged). Chosen only for ad_packs.route = 'leaddb'.
 *
 *   renderCarousel     3a, the report-page carousel: each card is ONE masked example report page whole in a rounded
 *                      card (about 960 px wide on 1080) on the cream or white base, one caption (the ad's on-screen
 *                      line), the logo strip; the last card is the CTA. At the three Meta sizes. The type-only cards
 *                      stay only as the fallback when the example report failed.
 *   renderPhoneFrames  5b, the two phone frames of the phone recording, DRAWN (Zac: no Playwright) from the customer's
 *                      calculator design: their colour and logo, the step-two form as LeadForm.tsx shows it ("Property
 *                      address", "Postcode", "Bedrooms", "Sleeps (guests)", "Show my estimate"), empty then filled
 *                      with the example ("Example property, <area>").
 *   measurePng         the picture measure the gate reads (ld-gate.ts): a 4-bin per channel histogram and a 32x32
 *                      grey thumbnail, with sharp.
 *
 * No Stayful asset, word or figure: the only words are the customer's company, the pack's own lines and LeadForm's labels.
 */
import React from 'react';
import { ImageResponse } from 'next/og';
import sharp from 'sharp';
import { pickTextColour } from './checks.ts';
import { cleanCompany, cleanText, loadFonts, resolveImage, SIZE_PX, type CardSize, type FetchImage, type ResolvedImage } from './images.tsx';
import { BASE_HEX, CTA_LINE, EXAMPLE_STAMP, type LookBase } from './ld-angles.ts';
import { exampleAddress } from './example-report.ts';
import { colourHistogram, THUMB, type PictureStats } from './ld-gate.ts';
import { carouselName, CAROUSEL_CARD_W, CAROUSEL_SIZES, phoneFrameLabels } from './ld-images-plan.ts';

const DEFAULT = '#1F3A5F';
const hex = (c: string | null | undefined) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c.trim()) ? c.trim() : DEFAULT);
const dataUri = (png: Uint8Array) => `data:image/png;base64,${Buffer.from(png).toString('base64')}`;

async function toPng(element: React.ReactElement, width: number, height: number): Promise<Uint8Array> {
  const res = new ImageResponse(element, { width, height, fonts: await loadFonts(), emoji: 'twemoji' });
  return new Uint8Array(await res.arrayBuffer());
}

function LogoStrip({ brand, logo, width, company }: { brand: string; logo: ResolvedImage | null; width: number; company: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', width, height: 96, padding: '0 24px', borderRadius: 26, backgroundColor: brand }}>
      {logo ? (
        <div style={{ display: 'flex', padding: 8, marginRight: 20, borderRadius: 14, backgroundColor: '#ffffff' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt="" src={logo.dataUri} height={56} style={{ height: 56, objectFit: 'contain' }} />
        </div>
      ) : null}
      <div style={{ display: 'flex', fontSize: 36, fontWeight: 600, color: pickTextColour(brand) }}>{company}</div>
    </div>
  );
}

function CarouselCard(p: { size: CardSize; base: string; brand: string; company: string; logo: ResolvedImage | null; caption: string; page: { uri: string; width: number; height: number } | null; cta: boolean }) {
  const { width, height } = SIZE_PX[p.size];
  const text = pickTextColour(p.brand);
  const ink = pickTextColour(p.base);
  const capSize = p.size === '1x1' ? 40 : 46;
  // The page sits whole inside its card: the card is CAROUSEL_CARD_W wide at most, and shorter when the page must fit the height.
  const room = height - 96 - 48 - (capSize * 2.6 + 40) - 96;
  let cw = CAROUSEL_CARD_W;
  let ch = 0;
  if (p.page) {
    ch = Math.round((p.page.height * cw) / p.page.width);
    if (ch > room) {
      ch = Math.floor(room);
      cw = Math.round((p.page.width * ch) / p.page.height);
    }
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width, height, padding: '48px 60px', backgroundColor: p.base, fontFamily: 'Archivo' }}>
      <div style={{ display: 'flex', width: width - 120, alignItems: 'center', justifyContent: 'space-between' }}>
        <LogoStrip brand={p.brand} logo={p.logo} width={width - 120} company={p.company} />
      </div>
      <div style={{ display: 'flex', marginTop: 28, width: width - 120, fontWeight: 600, fontSize: capSize, lineHeight: 1.15, color: ink }}>{p.caption}</div>
      {p.page && !p.cta ? (
        <div style={{ display: 'flex', position: 'relative', marginTop: 28, width: cw, height: ch, borderRadius: 34, overflow: 'hidden', backgroundColor: '#ffffff', border: '2px solid rgba(0,0,0,0.1)' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt="" src={p.page.uri} width={cw} height={ch} style={{ width: cw, height: ch }} />
          <div style={{ display: 'flex', position: 'absolute', top: 16, right: 16, padding: '8px 18px', borderRadius: 40, backgroundColor: 'rgba(17,17,17,0.9)', color: '#ffffff', fontSize: 28, fontWeight: 600 }}>{EXAMPLE_STAMP}</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flexGrow: 1 }}>
          <div style={{ display: 'flex', fontWeight: 600, fontSize: 56, color: ink, marginBottom: 36 }}>{p.company}</div>
          <div style={{ display: 'flex', padding: '26px 52px', borderRadius: 60, backgroundColor: p.brand, color: text, fontWeight: 600, fontSize: 50 }}>{CTA_LINE}</div>
          <div style={{ display: 'flex', marginTop: 30, fontWeight: 500, fontSize: 40, color: ink }}>You stay the owner.</div>
        </div>
      )}
    </div>
  );
}

/** 3a: the carousel. One card per page (the first three pages), then the CTA card; captions are the ad's screen lines in order. */
export async function renderCarousel(a: {
  pages: { png: Uint8Array; width: number; height: number }[];
  captions: string[];
  brand: { company: string; brandColour: string; logoUrl: string | null };
  base: LookBase;
  fetchImage?: FetchImage;
}): Promise<{ name: string; width: number; height: number; png: Uint8Array }[]> {
  const brand = hex(a.brand.brandColour);
  const base = BASE_HEX[a.base];
  const company = cleanCompany(a.brand.company);
  const logo = a.fetchImage && a.brand.logoUrl ? await resolveImage(a.brand.logoUrl, a.fetchImage) : null;
  const pages = a.pages.slice(0, 3).map((p) => ({ uri: dataUri(p.png), width: p.width, height: p.height }));
  const captions = a.captions.map(cleanText);
  const out: { name: string; width: number; height: number; png: Uint8Array }[] = [];
  const count = pages.length + 1;
  for (let i = 0; i < count; i++) {
    const cta = i === count - 1;
    const caption = cta ? captions[captions.length - 1] ?? CTA_LINE : captions[i] ?? '';
    for (const size of CAROUSEL_SIZES) {
      const { width, height } = SIZE_PX[size];
      const png = await toPng(<CarouselCard size={size} base={base} brand={brand} company={company} logo={logo} caption={caption} page={cta ? null : pages[i]} cta={cta} />, width, height);
      out.push({ name: carouselName(i + 1, size), width, height, png });
    }
  }
  return out;
}

function Field({ label, value, placeholder }: { label: string; value: string | null; placeholder?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', marginTop: 34 }}>
      <div style={{ display: 'flex', fontSize: 30, fontWeight: 500, color: '#111111' }}>{label}</div>
      <div style={{ display: 'flex', marginTop: 12, height: 84, alignItems: 'center', padding: '0 24px', borderRadius: 18, border: '2px solid #d4d4d8', backgroundColor: '#ffffff', fontSize: 32, color: value ? '#111111' : '#9ca3af' }}>{value ?? placeholder ?? ''}</div>
    </div>
  );
}

/** 5b: the calculator on a phone, empty then filled with the example (780 x 1688, the phone at 2x). */
export async function renderPhoneFrames(a: { company: string; brandColour: string | null; logoUrl: string | null; areaLabel: string; bedrooms: number | null; fetchImage?: FetchImage }): Promise<Uint8Array[]> {
  const brand = hex(a.brandColour);
  const text = pickTextColour(brand);
  const company = cleanCompany(a.company);
  const logo = a.fetchImage && a.logoUrl ? await resolveImage(a.logoUrl, a.fetchImage) : null;
  const labels = phoneFrameLabels();
  const beds = a.bedrooms && a.bedrooms > 0 ? a.bedrooms : 2;
  const filled = { address: exampleAddress(a.areaLabel), postcode: '', bedrooms: String(beds), guests: String(Math.min(16, beds * 2)) };
  const frame = (fill: boolean) => (
    <div style={{ display: 'flex', flexDirection: 'column', width: 780, height: 1688, backgroundColor: '#ffffff', fontFamily: 'Archivo' }}>
      <div style={{ display: 'flex', alignItems: 'center', height: 180, padding: '60px 40px 0', backgroundColor: brand }}>
        {logo ? (
          <div style={{ display: 'flex', padding: 8, marginRight: 22, borderRadius: 14, backgroundColor: '#ffffff' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img alt="" src={logo.dataUri} height={60} style={{ height: 60, objectFit: 'contain' }} />
          </div>
        ) : null}
        <div style={{ display: 'flex', fontSize: 38, fontWeight: 600, color: text }}>{company}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', padding: '50px 48px' }}>
        <div style={{ display: 'flex', fontSize: 50, fontWeight: 600, color: '#111111' }}>{labels.heading}</div>
        <div style={{ display: 'flex', marginTop: 18, fontSize: 28, color: '#6b7280' }}>{labels.step}</div>
        <Field label={labels.address} value={fill ? filled.address : null} placeholder={labels.addressPlaceholder} />
        <Field label={labels.postcode} value={fill ? filled.postcode || ' ' : null} />
        <div style={{ display: 'flex', gap: 24 }}>
          <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1 }}>
            <Field label={labels.bedrooms} value={fill ? filled.bedrooms : null} placeholder="Choose" />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1 }}>
            <Field label={labels.guests} value={fill ? filled.guests : null} placeholder="Choose" />
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 56, height: 96, alignItems: 'center', borderRadius: 20, backgroundColor: brand, color: text, fontSize: 36, fontWeight: 600 }}>{labels.button}</div>
      </div>
    </div>
  );
  return [await toPng(frame(false), 780, 1688), await toPng(frame(true), 780, 1688)];
}

/** The picture measure of one PNG (ld-gate.ts): 64-bin histogram and a 32x32 grey thumbnail. */
export async function measurePng(png: Uint8Array): Promise<PictureStats> {
  const small = await sharp(png).removeAlpha().resize(64, 114, { fit: 'fill' }).raw().toBuffer();
  const thumb = await sharp(png).removeAlpha().greyscale().resize(THUMB, THUMB, { fit: 'fill' }).raw().toBuffer();
  return { hist: colourHistogram(new Uint8Array(small), 3), thumb: Array.from(thumb) };
}
