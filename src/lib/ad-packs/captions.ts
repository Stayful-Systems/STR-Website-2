/**
 * Batch 38b: from a character-level alignment to the `script` block of brief.json.
 *
 * ElevenLabs `POST /v1/text-to-speech/{voice}/with-timestamps` returns
 * `alignment` (one entry per character of the text we SENT) and
 * `normalized_alignment` (the text after the voice's own normalisation:
 * numbers and symbols spelt out). We read `alignment`, because the script is
 * already spoken English (numbers in words) and its characters are the ones we
 * sent, so every word can be tied back to the line it came from.
 *
 * Lines are sent as paragraphs (a blank line between them), which the voice
 * reads as a short pause. A line's start and end are the start of its first
 * word and the end of its last word, so the fee sentence being part of line 4
 * (or the whole script having 4 lines) needs no special case: lines are
 * numbered L1..Ln by position.
 *
 * The Python renderer builds its own burned-in captions from `words`;
 * `captionChunks` here is the same idea for previews, tests and the captions
 * check.
 *
 * Pure: no network, no server-only. Never puts script text in an error.
 */

export type Alignment = {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
};

export type ScriptWord = { text: string; start: number; end: number };
export type ScriptLine = { id: string; text: string; start: number; end: number };
export type BriefScript = { lines: ScriptLine[]; words: ScriptWord[]; duration: number };

/** The most lines the renderer maps to scenes (SCRIPT_5B has 5). */
export const MAX_SCRIPT_LINES = 5;
/** Silence kept after the last word so the video does not cut the voice off. */
export const TAIL_SECONDS = 0.4;

export class AlignmentError extends Error {
  readonly reason: 'no_lines' | 'bad_alignment' | 'mismatch' | 'empty_line';
  constructor(reason: AlignmentError['reason']) {
    super(`alignment: ${reason}`);
    this.name = 'AlignmentError';
    this.reason = reason;
  }
}

/** Trimmed, whitespace-collapsed, blank lines dropped: the lines that are sent and numbered. */
export function cleanLines(lines: readonly string[]): string[] {
  return lines.map((l) => String(l ?? '').replace(/\s+/g, ' ').trim()).filter((l) => l !== '');
}

/** The text sent to the voice: one paragraph per line, so each line starts after a pause. */
export function joinScriptLines(lines: readonly string[]): string {
  return cleanLines(lines).join('\n\n');
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const isSpace = (c: string) => c.trim() === '';
const codePoints = (s: string) => Array.from(s).length;

function readAlignment(a: Alignment): { chars: string[]; start: number[]; end: number[] } {
  const chars = a?.characters;
  const start = a?.character_start_times_seconds;
  const end = a?.character_end_times_seconds;
  if (!Array.isArray(chars) || !Array.isArray(start) || !Array.isArray(end)) throw new AlignmentError('bad_alignment');
  if (chars.length === 0 || chars.length !== start.length || chars.length !== end.length) throw new AlignmentError('bad_alignment');
  for (let i = 0; i < chars.length; i++) {
    if (typeof chars[i] !== 'string' || !Number.isFinite(start[i]) || !Number.isFinite(end[i])) throw new AlignmentError('bad_alignment');
  }
  return { chars, start, end };
}

/**
 * The script block of brief.json (exactly the contract's shape) from the lines
 * that were sent and the voice's alignment of them. Throws AlignmentError
 * (never carrying text) when the alignment is not of these lines.
 */
export function buildBriefScript(lines: readonly string[], alignment: Alignment): BriefScript {
  const clean = cleanLines(lines);
  if (clean.length === 0 || clean.length > MAX_SCRIPT_LINES) throw new AlignmentError('no_lines');
  const { chars, start, end } = readAlignment(alignment);

  // The non-space characters of what was sent must be the non-space characters of the alignment.
  const sent = clean.join('').replace(/\s+/g, '');
  const got = chars.join('').replace(/\s+/g, '');
  if (sent !== got) throw new AlignmentError('mismatch');

  // lineEnds[i] = number of non-space code points up to the end of line i.
  const lineEnds: number[] = [];
  let run = 0;
  for (const l of clean) {
    run += codePoints(l.replace(/\s+/g, ''));
    lineEnds.push(run);
  }
  const lineOf = (k: number) => lineEnds.findIndex((e) => k < e);

  type W = { text: string; start: number; end: number; line: number };
  const words: W[] = [];
  let cur: W | null = null;
  let k = 0; // non-space code points seen so far
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (isSpace(c)) {
      cur = null;
      continue;
    }
    const line = lineOf(k);
    if (cur === null || cur.line !== line) {
      cur = { text: '', start: start[i], end: end[i], line };
      words.push(cur);
    }
    cur.text += c;
    cur.end = Math.max(cur.end, end[i]);
    k += codePoints(c);
  }

  const outLines: ScriptLine[] = [];
  for (let li = 0; li < clean.length; li++) {
    const own = words.filter((w) => w.line === li);
    if (own.length === 0) throw new AlignmentError('empty_line');
    outLines.push({
      id: `L${li + 1}`,
      text: clean[li],
      start: round3(Math.min(...own.map((w) => w.start))),
      end: round3(Math.max(...own.map((w) => w.end))),
    });
  }
  const outWords: ScriptWord[] = words.map((w) => ({ text: w.text, start: round3(w.start), end: round3(Math.max(w.end, w.start)) }));
  const lastEnd = Math.max(...outWords.map((w) => w.end));
  return { lines: outLines, words: outWords, duration: round3(lastEnd + TAIL_SECONDS) };
}

/** Checks a script block against the brief.json contract. */
export function validateBriefScript(script: unknown): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const s = script as Partial<BriefScript> | null;
  if (!s || typeof s !== 'object' || !Array.isArray(s.lines) || !Array.isArray(s.words) || typeof s.duration !== 'number') {
    return { ok: false, problems: ['shape'] };
  }
  const EPS = 1e-6;
  if (s.words.length === 0) problems.push('no words');
  if (s.lines.length === 0 || s.lines.length > MAX_SCRIPT_LINES) problems.push('line count');
  if (!Number.isFinite(s.duration)) problems.push('duration');

  let prevStart = -Infinity;
  let lastEnd = 0;
  s.words.forEach((w, i) => {
    if (!w || typeof w.text !== 'string' || w.text === '' || !Number.isFinite(w.start) || !Number.isFinite(w.end)) {
      problems.push(`word ${i + 1} shape`);
      return;
    }
    if (w.start < 0) problems.push(`word ${i + 1} negative`);
    if (w.end < w.start - EPS) problems.push(`word ${i + 1} ends before it starts`);
    if (w.start < prevStart - EPS) problems.push(`word ${i + 1} out of order`);
    prevStart = w.start;
    lastEnd = Math.max(lastEnd, w.end);
  });

  let prevEnd = -Infinity;
  s.lines.forEach((l, i) => {
    if (!l || l.id !== `L${i + 1}`) problems.push(`line ${i + 1} id`);
    if (!l || typeof l.text !== 'string' || l.text === '') problems.push(`line ${i + 1} text`);
    if (!l || !Number.isFinite(l.start) || !Number.isFinite(l.end)) {
      problems.push(`line ${i + 1} times`);
      return;
    }
    if (l.end < l.start - EPS) problems.push(`line ${i + 1} ends before it starts`);
    if (l.start < prevEnd - EPS) problems.push(`line ${i + 1} overlaps the one before`);
    prevEnd = l.end;
    lastEnd = Math.max(lastEnd, l.end);
  });

  if (Number.isFinite(s.duration) && s.duration <= lastEnd) problems.push('duration not past the last end');
  return { ok: problems.length === 0, problems };
}

// ── Caption chunks ──

export type CaptionChunk = { text: string; lines: string[]; start: number; end: number };
export type CaptionOptions = { maxChars?: number; maxLines?: number; pauseGap?: number };

/** Words wrapped into at most `maxLines` lines of `maxChars`; null if they do not fit. */
function wrap(words: readonly string[], maxChars: number, maxLines: number): string[] | null {
  const joined = words.join(' ');
  if (words.length === 1 || joined.length <= maxChars) return [joined];
  if (maxLines < 2) return null;
  let best: string[] | null = null;
  let bestMax = Infinity;
  for (let k = 1; k < words.length; k++) {
    const a = words.slice(0, k).join(' ');
    const b = words.slice(k).join(' ');
    if (a.length > maxChars || b.length > maxChars) continue;
    const m = Math.max(a.length, b.length);
    if (m < bestMax) {
      bestMax = m;
      best = [a, b];
    }
  }
  return best;
}

/**
 * Burned-in caption chunks: at most 2 lines of about 28 characters, cut where
 * the voice pauses (sentence end, a gap, or a comma once the chunk has some
 * length) rather than only where the line is full.
 */
export function captionChunks(words: readonly ScriptWord[], opts: CaptionOptions = {}): CaptionChunk[] {
  const maxChars = opts.maxChars ?? 28;
  const maxLines = opts.maxLines ?? 2;
  const pauseGap = opts.pauseGap ?? 0.35;
  const softMin = Math.floor(maxChars * 0.6);
  const out: CaptionChunk[] = [];
  let cur: ScriptWord[] = [];

  const flush = () => {
    if (cur.length === 0) return;
    const lines = wrap(cur.map((w) => w.text), maxChars, maxLines) ?? [cur.map((w) => w.text).join(' ')];
    out.push({ text: lines.join('\n'), lines, start: cur[0].start, end: cur[cur.length - 1].end });
    cur = [];
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (cur.length > 0 && wrap([...cur, w].map((x) => x.text), maxChars, maxLines) === null) flush();
    cur.push(w);
    const next = words[i + 1];
    if (!next) break;
    const hardStop = /[.!?…]["'”’)\]]*$/.test(w.text);
    const pause = next.start - w.end >= pauseGap;
    const softStop = /[,;:—–]$/.test(w.text) && cur.map((x) => x.text).join(' ').length >= softMin;
    if (hardStop || pause || softStop) flush();
  }
  flush();
  return out;
}
