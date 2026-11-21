import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LEAD_STAGES, type LeadStage } from './stage.ts';
import { meetingStampFor, reachesMeeting } from './meeting-stamp.ts';

const NOW = new Date('2026-11-21T10:00:00.000Z');
const FIRST = '2026-11-01T09:00:00.000Z';

test('only Meeting booked and Signed reach a meeting', () => {
  const hits = LEAD_STAGES.filter(reachesMeeting);
  assert.deepEqual(hits, ['meeting_booked', 'signed']);
});

test('stamp is set on the first meeting_booked or signed', () => {
  assert.equal(meetingStampFor(null, 'meeting_booked', NOW), NOW.toISOString());
  assert.equal(meetingStampFor(null, 'signed', NOW), NOW.toISOString());
});

test('stamp is unchanged by a later Lost, a second meeting move, or other stages', () => {
  for (const s of LEAD_STAGES as readonly LeadStage[]) {
    assert.equal(meetingStampFor(FIRST, s, NOW), null, `${s} must not change an existing stamp`);
  }
});

test('New, Contacted and Lost never stamp a lead that has no stamp', () => {
  for (const s of ['new', 'contacted', 'lost'] as const) assert.equal(meetingStampFor(null, s, NOW), null);
});

const action = readFileSync(new URL('../../app/leads/lead-actions.ts', import.meta.url), 'utf8');
const stageFn = action.slice(action.indexOf('export async function setLeadStageAction'), action.indexOf('export async function markLeadOpenedAction'));

test('the stage action logs lead_action with {action:"stage"}', () => {
  assert.match(stageFn, /logActivity\(s\.userId, 'lead_action', \{ extras: \{ action: 'stage'/);
});

test('the stage action refuses a paused seat or no session before any write', () => {
  assert.ok(stageFn.indexOf('await scope()') < stageFn.indexOf('.update('));
  assert.match(stageFn, /if \(!s\) return \{ error:/);
  assert.match(action, /s === 'paused' \? null/);
});

test('the stamp is written once, scoped by owner, and never touches status or crm_pushed_at', () => {
  assert.match(stageFn, /meeting_reached_at: stamp/);
  assert.match(stageFn, /\.is\('meeting_reached_at', null\)/);
  assert.doesNotMatch(stageFn, /crm_pushed_at/);
  assert.doesNotMatch(stageFn, /\bstatus\b\s*:/);
  const stampBlock = stageFn.slice(stageFn.indexOf('meeting_reached_at: stamp'));
  assert.match(stampBlock.slice(0, 200), /\.eq\('user_id', s\.ownerId\)/);
  assert.doesNotMatch(stageFn, /meeting_reached_at: null/);
});

test('the stage taps replace the select on the card and the lead page', () => {
  const list = readFileSync(new URL('../../app/leads/LeadList.tsx', import.meta.url), 'utf8');
  const detail = readFileSync(new URL('../../app/leads/[id]/LeadDetailActions.tsx', import.meta.url), 'utf8');
  assert.match(list, /<StageTaps/);
  assert.match(detail, /<StageTaps/);
  assert.doesNotMatch(detail, /<select/);
});

test('the API stage setter stamps once through the same helper, scoped by owner, never clearing and never touching status', () => {
  const src = readFileSync(new URL('../api/leads-write.ts', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function setLeadStage'));
  assert.match(src, /from '\.\.\/leads\/meeting-stamp'/);
  assert.match(fn, /meetingStampFor\(null, stage, new Date\(\)\)/);
  assert.match(fn, /meeting_reached_at: stamp/);
  assert.match(fn, /\.is\('meeting_reached_at', null\)/);
  const stampBlock = fn.slice(fn.indexOf('meeting_reached_at: stamp'));
  assert.match(stampBlock.slice(0, 200), /\.eq\('user_id', userId\)/);
  assert.doesNotMatch(fn, /meeting_reached_at: null/);
  assert.doesNotMatch(fn, /crm_pushed_at/);
  assert.doesNotMatch(fn, /\bstatus\b\s*:/);
});
