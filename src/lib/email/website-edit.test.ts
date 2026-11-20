import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminRequestKey, closedRequestKey, renderRequestEmail, requestAdminCopy, requestClosedCopy } from './website-edit.ts';

const BODY = 'Please put my number <b>0113 496 0123</b> in the footer\nand mention 12 Acacia Avenue';

test('the admin email names the company, never what they wrote, in the subject; the text is in the body, escaped', () => {
  const copy = requestAdminCopy({ company: 'Harbour Lets', body: BODY, hasScreenshot: false });
  assert.equal(copy.subject, 'New website change request: Harbour Lets');
  assert.doesNotMatch(copy.subject, /Acacia|footer|0113/);
  const r = renderRequestEmail(copy, 'https://app.example');
  assert.match(r.html, /&lt;b&gt;0113 496 0123&lt;\/b&gt;/, 'escaped');
  assert.doesNotMatch(r.html, /<b>0113/);
  assert.match(r.html, /footer<br>and mention/, 'line breaks kept');
  assert.match(r.html, /https:\/\/app\.example\/admin\/websites/);
  assert.match(r.text, /> Please put my number/);
});

test('a company name with a line break or control characters cannot break the subject', () => {
  const copy = requestAdminCopy({ company: 'Evil\r\nBcc: x@y.test\u0000', body: 'x', hasScreenshot: false });
  assert.doesNotMatch(copy.subject, /[\r\n\u0000]/);
  assert.equal(requestAdminCopy({ company: null, body: 'x', hasScreenshot: false }).subject, 'New website change request: a customer website');
});

test('a screenshot is mentioned, never linked', () => {
  const copy = requestAdminCopy({ company: 'Harbour', body: 'x', hasScreenshot: true });
  const r = renderRequestEmail(copy, 'https://app.example');
  assert.match(r.text, /attached a screenshot/);
  assert.doesNotMatch(r.html + r.text, /website-requests|signed|\.png|\.jpg/);
});

test('the closed email: done and declined each have their own plain subject, the owner\'s words and the admin note', () => {
  const done = requestClosedCopy({ status: 'done', body: BODY, adminNote: 'Added to the footer.' });
  assert.equal(done.subject, 'Your website change is done');
  const declined = requestClosedCopy({ status: 'declined', body: BODY, adminNote: null });
  assert.equal(declined.subject, "We can't make your website change");
  for (const c of [done, declined]) assert.doesNotMatch(c.subject, /Acacia|footer|0113/);
  const r = renderRequestEmail(done, 'https://app.example');
  assert.match(r.html, /Note from us: Added to the footer\./);
  assert.match(r.html, /https:\/\/app\.example\/leads\/website/);
  assert.match(r.html, /&lt;b&gt;0113/);
  assert.doesNotMatch(renderRequestEmail(declined, 'https://app.example').html, /Note from us/);
});

test('a note with HTML is escaped', () => {
  const r = renderRequestEmail(requestClosedCopy({ status: 'done', body: 'x', adminNote: '<script>alert(1)</script>' }), 'https://app.example');
  assert.doesNotMatch(r.html, /<script>/);
  assert.match(r.html, /&lt;script&gt;/);
});

test('the idempotency keys are one per request per admin address, and one per request for the operator', () => {
  assert.equal(adminRequestKey('abc', 'Zac@Stayful.co.uk '), 'website-request:abc:zac@stayful.co.uk');
  assert.notEqual(adminRequestKey('abc', 'a@x.test'), adminRequestKey('abc', 'b@x.test'));
  assert.equal(closedRequestKey('abc'), 'website-request-closed:abc');
});

test('these are direct replies: nothing here goes through the daily cap', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./website-edit.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /notify\/(cap|sends)|claimSlot|SendKind/);
  assert.match(src, /idempotencyKey/);
});
