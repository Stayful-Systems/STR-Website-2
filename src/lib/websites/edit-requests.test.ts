import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUEST_BODY_MAX,
  REQUEST_STATUSES,
  SCREENSHOT_MAX_BYTES,
  canTransition,
  isClosedStatus,
  isOurScreenshotPath,
  isOpenStatus,
  nextStatuses,
  requestStatusLabel,
  screenshotPath,
  screenshotRefusal,
  validateAdminNotes,
  validateRequestBody,
} from './edit-requests.ts';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const OWNER = '11111111-1111-4111-8111-111111111111';
const REQ = '22222222-2222-4222-8222-222222222222';

test('the body is 1 to 2000 characters once trimmed; empty and blank are refused', () => {
  assert.deepEqual(validateRequestBody('  Please add a Ripon page.  '), { ok: true, value: 'Please add a Ripon page.' });
  for (const bad of ['', '   ', '\n\n', null, undefined, 42, {}]) assert.equal(validateRequestBody(bad).ok, false, String(bad));
  assert.equal(validateRequestBody('x'.repeat(REQUEST_BODY_MAX)).ok, true);
  const long = validateRequestBody('x'.repeat(REQUEST_BODY_MAX + 1));
  assert.equal(long.ok, false);
  assert.match(long.ok ? '' : long.error, /2000/);
  assert.equal(validateRequestBody('line one\r\nline two').ok && (validateRequestBody('line one\r\nline two') as { value: string }).value, 'line one\nline two');
});

test('admin notes are optional and up to 2000 characters', () => {
  assert.deepEqual(validateAdminNotes(undefined), { ok: true, value: null });
  assert.deepEqual(validateAdminNotes(null), { ok: true, value: null });
  assert.deepEqual(validateAdminNotes('   '), { ok: true, value: null });
  assert.deepEqual(validateAdminNotes(' Done on the About page. '), { ok: true, value: 'Done on the About page.' });
  assert.equal(validateAdminNotes('x'.repeat(2000)).ok, true);
  assert.equal(validateAdminNotes('x'.repeat(2001)).ok, false);
  assert.equal(validateAdminNotes(5).ok, false);
});

test('status moves: new to in progress, done or declined; in progress to done or declined; closed is final', () => {
  assert.deepEqual([...REQUEST_STATUSES], ['new', 'in_progress', 'done', 'declined']);
  for (const to of ['in_progress', 'done', 'declined'] as const) assert.equal(canTransition('new', to), true, `new -> ${to}`);
  for (const to of ['done', 'declined'] as const) assert.equal(canTransition('in_progress', to), true, `in_progress -> ${to}`);
  assert.equal(canTransition('in_progress', 'new'), false);
  for (const from of ['done', 'declined'] as const) for (const to of REQUEST_STATUSES) assert.equal(canTransition(from, to), false, `${from} -> ${to}`);
  for (const s of REQUEST_STATUSES) assert.equal(canTransition(s, s), false, 'staying put is not a move');
  assert.deepEqual(nextStatuses('done'), []);
  assert.equal(isClosedStatus('done') && isClosedStatus('declined'), true);
  assert.equal(isOpenStatus('new') && isOpenStatus('in_progress') && !isOpenStatus('done'), true);
  assert.equal(requestStatusLabel('declined'), 'Not going ahead');
});

test('a screenshot is a PNG or JPEG by its bytes, under 1 MB', () => {
  assert.equal(screenshotRefusal(PNG), null);
  assert.equal(screenshotRefusal(JPG), null);
  assert.match(screenshotRefusal(new Uint8Array(0)) ?? '', /empty/);
  assert.match(screenshotRefusal(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')) ?? '', /PNG or a JPEG/);
  assert.match(screenshotRefusal(new TextEncoder().encode('%PDF-1.4 ....')) ?? '', /PNG or a JPEG/);
  const big = new Uint8Array(SCREENSHOT_MAX_BYTES);
  big.set(PNG);
  assert.match(screenshotRefusal(big) ?? '', /1 MB/);
  const ok = new Uint8Array(SCREENSHOT_MAX_BYTES - 1);
  ok.set(PNG);
  assert.equal(screenshotRefusal(ok), null);
});

test('the screenshot path is <owner>/<id>.<ext>, from the sniffed type, and only for uuids', () => {
  assert.equal(screenshotPath(OWNER, REQ, 'image/png'), `${OWNER}/${REQ}.png`);
  assert.equal(screenshotPath(OWNER, REQ, 'image/jpeg'), `${OWNER}/${REQ}.jpg`);
  assert.equal(screenshotPath('../x', REQ, 'image/png'), null);
  assert.equal(screenshotPath(OWNER, 'not-a-uuid', 'image/png'), null);
  assert.equal(isOurScreenshotPath(`${OWNER}/${REQ}.png`), true);
  for (const bad of ['', '../etc/passwd', `${OWNER}/../${REQ}.png`, `${OWNER}/${REQ}.svg`, `${OWNER}/${REQ}`, null, 5]) assert.equal(isOurScreenshotPath(bad), false, String(bad));
});
