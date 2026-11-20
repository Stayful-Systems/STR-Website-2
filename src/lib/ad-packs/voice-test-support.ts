/**
 * Test support for the voiceover code (not a test: the `npm test` glob is *.test.ts).
 *
 * `makeAlignment(text)` builds a hand-made character-level alignment with the
 * real response SHAPE of ElevenLabs' /with-timestamps endpoint: about 0.065 s a
 * character, a short pause after commas and a longer one after full stops and
 * between paragraphs. It is deterministic, and fixtures/alignment-notice.json
 * is its output for the sample operator's 5 script lines (a test pins that).
 */
import { buildFigure } from './figures.ts';
import { renderScript, type AngleBrand } from './angles.ts';
import { joinScriptLines, type Alignment } from './captions.ts';

export function makeAlignment(text: string, opts: { charSeconds?: number; startAt?: number } = {}): Alignment {
  const per = opts.charSeconds ?? 0.065;
  let t = opts.startAt ?? 0.1;
  const characters: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (const ch of Array.from(text)) {
    const dur = ch === ' ' ? per * 0.6 : ch === '\n' ? 0.35 : per;
    const pause = ch === ',' || ch === ';' ? 0.18 : ch === '.' || ch === '?' || ch === '!' ? 0.3 : 0;
    characters.push(ch);
    starts.push(Math.round(t * 1000) / 1000);
    t += dur + pause;
    ends.push(Math.round(t * 1000) / 1000);
  }
  return { characters, character_start_times_seconds: starts, character_end_times_seconds: ends };
}

/** A with-timestamps response body for `text`. The audio is a few placeholder bytes, not real mp3. */
export function makeTtsResponse(text: string): { audio_base64: string; alignment: Alignment; normalized_alignment: Alignment } {
  const alignment = makeAlignment(text);
  return { audio_base64: Buffer.from('ID3-test-audio-bytes').toString('base64'), alignment, normalized_alignment: alignment };
}

const AGG = { bedrooms: 3, sample_count: 14, avg_gross_revenue: 48_200, avg_net_revenue: 31_000, avg_occupancy: 71.4 };

export const SAMPLE_BRAND: AngleBrand = { company: 'Brightstone Stays', area: 'Cambridge', bedrooms: 3, feePct: 12 };

/** The 5b script lines for the sample operator (with a figure), optionally without a fee. */
export function sampleScriptLines(opts: { fee?: boolean } = {}): string[] {
  const brand = { ...SAMPLE_BRAND, feePct: opts.fee === false ? null : SAMPLE_BRAND.feePct };
  const figure = buildFigure({ area_label: 'Cambridge', agg: AGG, feePct: brand.feePct, netIncludesFee: false });
  return renderScript({ brand, figure }).lines;
}

export function sampleScriptText(opts: { fee?: boolean } = {}): string {
  return joinScriptLines(sampleScriptLines(opts));
}
