import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ELIGIBILITY_REASONS, LEADDB_ONLY_REASONS } from '../../../lib/ad-packs/eligibility.ts';
import { CHECK_IDS } from '../../../lib/ad-packs/checks.ts';
import { PACK_STATUSES } from '../../../lib/ad-packs/store-types.ts';
import { GENERATE_CODES } from '../../../lib/ad-packs/generate-core.ts';
import { MESSAGES } from './ops.ts';
import { KEPT_NOTICE } from './state.ts';
import {
  AD_TITLES,
  PLAIN_CODES,
  SIZE_INFO,
  adHeading,
  areaPreviewView,
  brandProblemText,
  eligibilityView,
  entryCardView,
  problemView,
  regenIntro,
  videoCardView,
  voiceCards,
  voiceVm,
} from './view.ts';

/**
 * Batch 38c: the Facebook ads screens use plain words. Nothing an operator reads may
 * use the words we use inside (pack, version, regenerate, checks, render, codes, allowance, hash,
 * "primary text", type-only). Two ways in: every sentence the view models can produce, and every
 * string and piece of text written in the components. The guide's own text has its twin in
 * guide.test.ts; the one place "Primary text" may appear there is the Facebook box name.
 */
const BANNED = /\b(?:packs?|versions?|regenerat\w*|checks|render\w*|codes?|allowance|hash|type-only)\b|primary text/i;

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The words in a source file that a person could read: text between tags, and strings with a space and a letter in them. */
function visibleStrings(src: string): string[] {
  const body = code(src)
    .split('\n')
    .filter((line) => !/^\s*(?:import|export) .* from /.test(line) && !/^\s*import /.test(line) && !/eslint-disable/.test(line))
    .join('\n');
  const out: string[] = [];
  for (const m of body.matchAll(/>([^<>{}=;]*[A-Za-z][^<>{}=;]*)</g)) out.push(m[1].trim());
  for (const m of body.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    const s = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}/g, ' ');
    if (/\s/.test(s) && /[A-Za-z]{3}/.test(s)) out.push(s);
  }
  return out.filter((s) => s !== '');
}

const FILES = ['page.tsx', 'StartForm.tsx', 'CoveragePicker.tsx', 'VoicePicker.tsx', 'VideoBlock.tsx', 'Screens.tsx', 'Gallery.tsx', 'Downloads.tsx', 'ui.tsx', 'EntryCard.tsx', 'guide/page.tsx', 'guide/GuideWizard.tsx', 'view.ts', 'ops.ts', 'state.ts'];

test('no component, page or view model writes an internal word in a sentence', () => {
  let scanned = 0;
  for (const f of FILES) {
    for (const s of visibleStrings(read(`./${f}`))) {
      scanned += 1;
      assert.doesNotMatch(s, BANNED, `${f}: "${s}"`);
    }
  }
  assert.ok(scanned > 150, `scanned ${scanned} strings`);
});

test('the scanner itself catches an internal word in text and in a string', () => {
  assert.ok(visibleStrings('<p>Your pack is ready</p>').some((s) => BANNED.test(s)));
  assert.ok(visibleStrings('const a = "Make a new version of it";').some((s) => BANNED.test(s)));
  assert.ok(visibleStrings('const a = `Regenerate now`;').some((s) => BANNED.test(s)));
  assert.equal(visibleStrings('import x from "the pack of things";').length, 0);
  assert.equal(visibleStrings('const k = "version";').length, 0, 'a single word is a field name, not a sentence');
});

test('every sentence the view models can produce is plain', () => {
  const said: string[] = [];
  for (const r of [...ELIGIBILITY_REASONS, ...LEADDB_ONLY_REASONS]) {
    const v = eligibilityView([r]);
    said.push(v.title, v.message, v.next?.text ?? '', v.next?.label ?? '');
  }
  for (const text of Object.values(PLAIN_CODES)) said.push(text);
  for (const code of GENERATE_CODES) assert.ok(PLAIN_CODES[code], `a plain sentence for ${code}`);
  for (const s of [null, ...PACK_STATUSES]) {
    const e = entryCardView(s);
    said.push(e.title, e.body, e.cta);
  }
  const problem = problemView({ failures: CHECK_IDS.map((check) => ({ check })) });
  said.push(problem.title, ...problem.lines, problem.contact, ...problemView(null).lines);
  said.push(areaPreviewView({ areaKey: 'NG7', areaLabel: 'Nottingham', fellBack: false, bedrooms: 3, samples: 9 }).text, areaPreviewView({ areaKey: 'NG', areaLabel: 'Nottingham', fellBack: true, bedrooms: 3, samples: 9 }).text, areaPreviewView({ error: 'not_enough_data' }).text);
  said.push(brandProblemText('company'), brandProblemText('colour'), regenIntro(1, null), regenIntro(2, null), regenIntro(0, null), KEPT_NOTICE, ...Object.values(MESSAGES));
  for (const status of ['queued', 'making', 'ready', 'failed', 'coming'] as const) {
    for (const code of [null, 'voice_unavailable', 'sandbox_failed']) {
      for (const canRetry of [true, false]) {
        const c = videoCardView({ status, code, poll: false, canRetry, message: 'Your pack could not be made.' });
        said.push(c.heading, c.message ?? '');
      }
    }
  }
  for (const v of [voiceVm({ key: 'jane', changesLeft: 1, canChange: true, free: false, blocked: null }), voiceVm({ key: 'jane', changesLeft: 0, canChange: false, free: false, blocked: { code: 'voice_limit_used', message: 'Your pack…' } }), voiceVm({ key: 'oliver', changesLeft: 2, canChange: true, free: true, blocked: { code: 'video_running', message: 'x' } })]) said.push(v.note, v.blocked ?? '');
  for (const v of voiceCards()) said.push(v.label, v.description);
  for (const t of Object.values(AD_TITLES)) said.push(t.title, t.blurb);
  for (const a of ['5b', '3a', '17'] as const) said.push(adHeading(a));
  for (const z of Object.values(SIZE_INFO)) said.push(z.label, z.hint);
  for (const s of said) assert.doesNotMatch(s, BANNED, s);
  assert.ok(said.filter((s) => s.length > 0).length > 60);
});

/** A string of style classes ("flex min-h-12 gap-2"), not a sentence. */
const looksLikeClasses = (s: string) => s.split(/\s+/).filter((t) => /^(?:[a-z0-9-]+:)*-?[a-z]+-[\w[\]/.#()%,-]+$/.test(t) || /^(?:flex|block|inline|hidden|grid|static|fixed|sr-only|shrink-0|truncate|underline)$/.test(t)).length >= 3;

test('the reading level stays low: no sentence on the screens is long', () => {
  // A sentence of more than 30 words is hard to read on a phone.
  const long: string[] = [];
  for (const f of ['view.ts', 'Screens.tsx', 'StartForm.tsx', 'VideoBlock.tsx', 'Gallery.tsx', 'guide/GuideWizard.tsx']) {
    for (const s of visibleStrings(read(`./${f}`))) {
      if (looksLikeClasses(s)) continue;
      for (const sentence of s.split(/[.!?]\s+/)) if (sentence.trim().split(/\s+/).length > 30) long.push(`${f}: ${sentence}`);
    }
  }
  assert.deepEqual(long, []);
});

test('Batch 55 step 5 (A7): the concept lines, the calculator hint and the gate’s reasons are plain', async () => {
  const { conceptLine, profileHint, LD_CHECK_PLAIN } = await import('./view.ts');
  const { LD_CHECK_IDS } = await import('../../../lib/ad-packs/ld-gate.ts');
  const said: string[] = [];
  for (const a of ['5b', '3a', '17'] as const) said.push(conceptLine(a));
  for (const p of [{ logoUrl: null, areas: [] }, { logoUrl: null, areas: ['Leeds'] }, { logoUrl: 'https://x.test/l.png', areas: [] }]) {
    const h = profileHint(p)!;
    said.push(h.text, h.label ?? '');
  }
  for (const id of LD_CHECK_IDS) said.push(LD_CHECK_PLAIN[id]);
  const problem = problemView({ failures: LD_CHECK_IDS.map((check) => ({ check })) });
  said.push(...problem.lines);
  for (const s of said) {
    assert.ok(s.length > 0);
    assert.doesNotMatch(s, BANNED, s);
  }
  assert.equal(problem.lines.length, LD_CHECK_IDS.length, 'every gate reason has its own plain line');
});
