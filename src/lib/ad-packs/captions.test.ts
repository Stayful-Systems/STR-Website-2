import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AlignmentError,
  MAX_SCRIPT_LINES,
  TAIL_SECONDS,
  buildBriefScript,
  captionChunks,
  cleanLines,
  joinScriptLines,
  validateBriefScript,
  type Alignment,
  type ScriptWord,
} from './captions.ts';
import { makeAlignment, makeTtsResponse, sampleScriptLines, sampleScriptText } from './voice-test-support.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/alignment-notice.json', import.meta.url), 'utf8')) as {
  audio_base64: string;
  alignment: Alignment;
  normalized_alignment: Alignment;
};

test('the recorded fixture has the real response shape and is of the sample script', () => {
  assert.equal(typeof fixture.audio_base64, 'string');
  for (const a of [fixture.alignment, fixture.normalized_alignment]) {
    assert.equal(a.characters.length, a.character_start_times_seconds.length);
    assert.equal(a.characters.length, a.character_end_times_seconds.length);
    assert.ok(a.characters.every((c) => typeof c === 'string' && Array.from(c).length === 1));
  }
  // If SCRIPT_5B changes this fails: regenerate with makeTtsResponse(sampleScriptText()).
  assert.equal(fixture.alignment.characters.join(''), sampleScriptText());
  assert.deepEqual(fixture.alignment, makeAlignment(sampleScriptText()));
});

test('fixture -> words, 5 lines, ids by position, durations', () => {
  const script = buildBriefScript(sampleScriptLines(), fixture.alignment);
  assert.equal(script.lines.length, 5);
  assert.deepEqual(script.lines.map((l) => l.id), ['L1', 'L2', 'L3', 'L4', 'L5']);
  assert.deepEqual(script.lines.map((l) => l.text), cleanLines(sampleScriptLines()));
  const spoken = sampleScriptText().split(/\s+/).filter(Boolean);
  assert.deepEqual(script.words.map((w) => w.text), spoken);
  assert.ok(script.words.length > 60);

  // Each line's span is its own words' span, in order, and the lines do not overlap.
  let wi = 0;
  script.lines.forEach((l, i) => {
    const n = l.text.split(/\s+/).length;
    const own = script.words.slice(wi, wi + n);
    wi += n;
    assert.equal(own.map((w) => w.text).join(' '), l.text, `line ${i + 1}`);
    assert.equal(l.start, own[0].start);
    assert.equal(l.end, own[own.length - 1].end);
    if (i > 0) assert.ok(l.start >= script.lines[i - 1].end, `line ${i + 1} starts after the previous ends`);
  });
  assert.equal(wi, script.words.length);

  const lastEnd = script.words[script.words.length - 1].end;
  assert.ok(script.duration > lastEnd);
  assert.equal(script.duration, Math.round((lastEnd + TAIL_SECONDS) * 1000) / 1000);
  // ~0.065 s a character: a 5-paragraph script of ~630 characters runs well over 40 s of speech time.
  assert.ok(script.duration > 30 && script.duration < 90, String(script.duration));
  assert.deepEqual(validateBriefScript(script), { ok: true, problems: [] });
});

test('exactly the contract shape (version-1 script block)', () => {
  const script = buildBriefScript(sampleScriptLines(), fixture.alignment);
  assert.deepEqual(Object.keys(script).sort(), ['duration', 'lines', 'words']);
  for (const l of script.lines) assert.deepEqual(Object.keys(l).sort(), ['end', 'id', 'start', 'text']);
  for (const w of script.words) assert.deepEqual(Object.keys(w).sort(), ['end', 'start', 'text']);
  assert.ok(script.lines.every((l) => /^L[1-5]$/.test(l.id)));
});

test('no fee in the brand: still five lines (the fee is part of line 4), and a four-line script', () => {
  const noFee = sampleScriptLines({ fee: false });
  assert.equal(noFee.length, 5);
  assert.ok(!noFee.join(' ').includes('management fee'));
  const a = buildBriefScript(noFee, makeAlignment(joinScriptLines(noFee)));
  assert.equal(a.lines.length, 5);
  assert.equal(a.lines[3].text, noFee[3]);

  // A line absent altogether: ids follow position, so the lines are L1..L4.
  const four = sampleScriptLines().filter((_, i) => i !== 3);
  const b = buildBriefScript(four, makeAlignment(joinScriptLines(four)));
  assert.deepEqual(b.lines.map((l) => l.id), ['L1', 'L2', 'L3', 'L4']);
  assert.equal(b.lines[3].text, four[3]);
  assert.deepEqual(validateBriefScript(b), { ok: true, problems: [] });
  // Blank lines are dropped before numbering.
  const c = buildBriefScript(['One.', '', '  ', 'Two.'], makeAlignment('One.\n\nTwo.'));
  assert.deepEqual(c.lines.map((l) => [l.id, l.text]), [['L1', 'One.'], ['L2', 'Two.']]);
});

test('punctuation, apostrophes, currency and numbers stay inside their words', () => {
  const lines = ["We're Hearth & Home, and it's \"yours\" (really).", 'The take-home is £1,100 a month, or 4.5% of £24,000.', 'Ask Zoë — it takes 5 mins…'];
  const s = buildBriefScript(lines, makeAlignment(joinScriptLines(lines)));
  const texts = s.words.map((w) => w.text);
  assert.ok(texts.includes("We're"));
  assert.ok(texts.includes("it's"));
  assert.ok(texts.includes('"yours"'));
  assert.ok(texts.includes('(really).'));
  assert.ok(texts.includes('£1,100'));
  assert.ok(texts.includes('4.5%'));
  assert.ok(texts.includes('£24,000.'));
  assert.ok(texts.includes('Zoë'));
  assert.ok(texts.includes('—'));
  assert.ok(texts.includes('mins…'));
  assert.equal(s.words.filter((w) => w.text.includes('£1,100')).length, 1);
  assert.equal(s.lines.length, 3);
  assert.equal(s.lines[1].text, lines[1]);
  assert.deepEqual(validateBriefScript(s), { ok: true, problems: [] });
});

test('whitespace differences between sent text and alignment do not matter; a different text does', () => {
  const lines = ['Hello there.', 'General Kenobi.'];
  const al = makeAlignment('Hello there. General Kenobi.'); // single spaces, no paragraph break
  const s = buildBriefScript(lines, al);
  assert.deepEqual(s.lines.map((l) => l.id), ['L1', 'L2']);
  assert.equal(s.words.length, 4);
  assert.throws(() => buildBriefScript(lines, makeAlignment('Hello there. Someone else.')), (e) => e instanceof AlignmentError && e.reason === 'mismatch');
  assert.throws(() => buildBriefScript([], al), (e) => e instanceof AlignmentError && e.reason === 'no_lines');
  assert.throws(() => buildBriefScript(['a', 'b', 'c', 'd', 'e', 'f'], al), (e) => e instanceof AlignmentError && e.reason === 'no_lines');
  assert.equal(MAX_SCRIPT_LINES, 5);
  const broken = { characters: ['a', 'b'], character_start_times_seconds: [0], character_end_times_seconds: [0.1, 0.2] };
  assert.throws(() => buildBriefScript(['ab'], broken), (e) => e instanceof AlignmentError && e.reason === 'bad_alignment');
  assert.throws(() => buildBriefScript(['ab'], null as unknown as Alignment), (e) => e instanceof AlignmentError);
});

test('an AlignmentError never carries the script text', () => {
  const secret = 'Totally secret sentence about 12 Acacia Avenue.';
  try {
    buildBriefScript([secret], makeAlignment('something else entirely'));
    assert.fail('should throw');
  } catch (e) {
    assert.ok(e instanceof AlignmentError);
    assert.ok(!String((e as Error).message).includes('Acacia'));
  }
});

test('validateBriefScript catches a bad block', () => {
  const good = buildBriefScript(sampleScriptLines(), fixture.alignment);
  const clone = () => JSON.parse(JSON.stringify(good)) as typeof good;
  const probs = (s: unknown) => validateBriefScript(s).problems.join('|');

  const dur = clone();
  dur.duration = dur.words[dur.words.length - 1].end;
  assert.match(probs(dur), /duration/);

  const ids = clone();
  ids.lines[2].id = 'L9';
  assert.match(probs(ids), /line 3 id/);

  const order = clone();
  [order.words[3], order.words[4]] = [order.words[4], order.words[3]];
  assert.match(probs(order), /out of order/);

  const neg = clone();
  neg.words[0].end = neg.words[0].start - 1;
  assert.match(probs(neg), /ends before/);

  const overlap = clone();
  overlap.lines[1].start = overlap.lines[0].end - 1;
  assert.match(probs(overlap), /overlaps/);

  const empty = clone();
  empty.words = [];
  assert.match(probs(empty), /no words/);

  const many = clone();
  many.lines = [...many.lines, ...many.lines];
  assert.match(probs(many), /line count/);

  assert.equal(validateBriefScript(null).ok, false);
  assert.equal(validateBriefScript({}).ok, false);
});

// ── captionChunks ──

const wordsOf = (lines: string[]): ScriptWord[] => buildBriefScript(lines, makeAlignment(joinScriptLines(lines))).words;

test('caption chunks stay within 2 lines x 28 characters and cover every word in order', () => {
  const words = buildBriefScript(sampleScriptLines(), fixture.alignment).words;
  const chunks = captionChunks(words);
  assert.ok(chunks.length > 10);
  for (const c of chunks) {
    assert.ok(c.lines.length >= 1 && c.lines.length <= 2, c.text);
    for (const l of c.lines) assert.ok(l.length <= 28, `"${l}" is ${l.length}`);
    assert.equal(c.text, c.lines.join('\n'));
    assert.ok(c.end >= c.start);
  }
  assert.equal(chunks.flatMap((c) => c.lines.join(' ').split(' ')).join(' '), words.map((w) => w.text).join(' '));
  for (let i = 1; i < chunks.length; i++) assert.ok(chunks[i].start >= chunks[i - 1].end - 1e-9, 'no overlap');
});

test('caption chunks break at sentence ends and pauses, not only when full', () => {
  const words = wordsOf(['Short one. Another short one. Third.']);
  const chunks = captionChunks(words);
  assert.deepEqual(chunks.map((c) => c.lines.join(' ')), ['Short one.', 'Another short one.', 'Third.']);

  // A gap between words (no punctuation) is a pause too.
  const gap: ScriptWord[] = [
    { text: 'before', start: 0, end: 0.4 },
    { text: 'the', start: 0.45, end: 0.6 },
    { text: 'gap', start: 0.65, end: 1 },
    { text: 'after', start: 1.8, end: 2.2 },
  ];
  assert.deepEqual(captionChunks(gap).map((c) => c.lines.join(' ')), ['before the gap', 'after']);

  // A comma breaks once the chunk has some length.
  const comma = wordsOf(['Guests book a few nights, and we run it all for you.']);
  assert.deepEqual(captionChunks(comma).map((c) => c.lines.join(' ')), ['Guests book a few nights,', 'and we run it all for you.']);
});

test('long text wraps to two balanced lines; a one-word overflow is its own line, not dropped', () => {
  const words = wordsOf(['Has your tenant handed in their notice?']);
  const [c] = captionChunks(words);
  assert.equal(c.lines.length, 2);
  assert.ok(Math.abs(c.lines[0].length - c.lines[1].length) <= 12);

  const long: ScriptWord[] = [{ text: 'Supercalifragilisticexpialidocious-and-more', start: 0, end: 1 }];
  const out = captionChunks(long);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, long[0].text);
  assert.deepEqual(captionChunks([]), []);
  assert.deepEqual(captionChunks(words, { maxChars: 20 }).every((x) => x.lines.every((l) => l.length <= 20)), true);
});

test('makeTtsResponse is a with-timestamps shaped body', () => {
  const r = makeTtsResponse('Hi there.');
  assert.deepEqual(Object.keys(r).sort(), ['alignment', 'audio_base64', 'normalized_alignment']);
});
