import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGuide } from './transfer-guide.ts';
import { domainMovedEmail, emailDay, exportFailedAdminEmail, filesReadyEmail, manualStepAdminEmail, stuckAlertAdminEmail, transferCodeEmail, transferRequestedAdminEmail } from './transfer-emails.ts';

const PANEL = 'https://app.example.test/admin/websites';
const PAGE = 'https://app.example.test/leads/website/transfer';
const CODE = 'ABCD-EFGH-1234';
const LINK = 'https://signed.example.test/zip?token=SECRET123';
const ID = '11111111-1111-4111-8111-111111111111';

const guide = buildGuide({ siteName: 'Northern Lets', domain: 'northernlets.co.uk', method: 'tag', provider: { name: 'Namecheap', tag: 'NAMECHEAP-INC', helpUrl: null }, formAction: 'https://app.example.test/api/t/0123456789abcdef/lead', ourCopyEnds: '2026-12-21T10:00:00Z' });

const all = (c: { subject: string; html: string; text: string }) => `${c.subject}\n${c.html}\n${c.text}`;

test('emailDay is a UK day in words, or null', () => {
  assert.equal(emailDay('2026-12-21T10:00:00Z'), '21 December 2026');
  assert.equal(emailDay('2026-06-30T23:30:00Z'), '1 July 2026');
  assert.equal(emailDay(null), null);
  assert.equal(emailDay('nope'), null);
});

test('files ready: attached, the guide is in the body and there is no link', () => {
  const c = filesReadyEmail({ siteName: 'Northern Lets', guideText: guide.text, attached: true, downloadUrl: LINK, ourCopyEnds: '2026-12-21T10:00:00Z', transferPageUrl: PAGE });
  assert.match(c.subject, /Northern Lets/);
  assert.match(c.text, /attached/);
  assert.ok(c.text.includes('How to use your exported website'), 'the guide text is in the email');
  assert.ok(c.text.includes('21 December 2026'));
  assert.ok(!all(c).includes(LINK) && !all(c).includes('SECRET123'), 'no link when it is attached');
  assert.ok(c.html.includes(PAGE));
});

test('files ready: too big, so a link; and without one it points at the page', () => {
  const c = filesReadyEmail({ siteName: 'Northern Lets', guideText: guide.text, attached: false, downloadUrl: LINK, ourCopyEnds: null, transferPageUrl: PAGE });
  assert.match(c.text, /too big to attach/);
  assert.ok(c.text.includes(LINK) && c.html.includes(LINK));
  const none = filesReadyEmail({ siteName: '', guideText: guide.text, attached: false, downloadUrl: null, ourCopyEnds: null, transferPageUrl: PAGE });
  assert.ok(!none.text.includes('http://') && none.text.includes(PAGE));
  assert.match(none.subject, /your website/);
});

test('the transfer code is in the code email and in no other email', () => {
  const c = transferCodeEmail({ siteName: 'Northern Lets', domain: 'northernlets.co.uk', code: CODE, providerName: 'Namecheap' });
  assert.ok(c.text.includes(CODE) && c.html.includes(CODE));
  assert.ok(!c.subject.includes(CODE), 'never in the subject');
  assert.match(c.text, /do not keep a copy/);
  const others = [
    filesReadyEmail({ siteName: 'N', guideText: guide.text, attached: true, downloadUrl: null, ourCopyEnds: null, transferPageUrl: PAGE }),
    domainMovedEmail({ siteName: 'N', domain: 'northernlets.co.uk', ourCopyEnds: null, transferPageUrl: PAGE }),
    transferRequestedAdminEmail({ transferId: ID, siteName: 'N', domain: 'northernlets.co.uk', providerName: 'Namecheap', method: 'code', tag: null, overlapEndsAt: null, panelUrl: PANEL }),
    manualStepAdminEmail({ transferId: ID, domain: 'northernlets.co.uk', providerName: 'Namecheap', step: 'code', tag: null, reason: 'refused', panelUrl: PANEL }),
    stuckAlertAdminEmail({ transferId: ID, domain: 'northernlets.co.uk', method: 'code', providerName: 'Namecheap', requestedAt: '2026-11-21T00:00:00Z', stuckDays: 5, panelUrl: PANEL }),
    exportFailedAdminEmail({ transferId: ID, siteName: 'N', code: 'fetch_500', attempts: 3, panelUrl: PANEL }),
  ];
  for (const o of others) assert.ok(!all(o).includes(CODE), o.subject);
});

test('moved email says so and when our copy stops', () => {
  const c = domainMovedEmail({ siteName: 'Northern Lets', domain: 'northernlets.co.uk', ourCopyEnds: '2026-12-21T10:00:00Z', transferPageUrl: PAGE });
  assert.match(c.subject, /moved/);
  assert.ok(c.text.includes('northernlets.co.uk') && c.text.includes('21 December 2026'));
});

test('admin emails: requested, manual (tag and code), stuck and failed say what to do and carry the panel link', () => {
  const requested = transferRequestedAdminEmail({ transferId: ID, siteName: 'Northern Lets', domain: 'northernlets.co.uk', providerName: 'Namecheap', method: 'tag', tag: 'NAMECHEAP-INC', overlapEndsAt: '2026-12-21T10:00:00Z', panelUrl: PANEL });
  assert.match(requested.subject, /requested/);
  assert.ok(requested.text.includes('NAMECHEAP-INC') && requested.text.includes('11111111') && requested.text.includes(PANEL));
  assert.ok(!requested.text.includes(ID), 'the short reference only');
  const filesOnly = transferRequestedAdminEmail({ transferId: ID, siteName: 'N', domain: null, providerName: 'None', method: 'none', tag: null, overlapEndsAt: null, panelUrl: PANEL });
  assert.match(filesOnly.text, /files only/);

  const tag = manualStepAdminEmail({ transferId: ID, domain: 'northernlets.co.uk', providerName: 'Namecheap', step: 'tag', tag: 'NAMECHEAP-INC', reason: 'refused', panelUrl: PANEL });
  assert.match(tag.subject, /change the tag/);
  assert.ok(tag.text.includes('Tag changed'));
  const code = manualStepAdminEmail({ transferId: ID, domain: 'northernlets.co.uk', providerName: 'Namecheap', step: 'code', tag: null, reason: 'refused', panelUrl: PANEL });
  assert.match(code.subject, /transfer code/);
  assert.ok(code.text.includes('Send code') && code.text.includes('not stored'));

  const stuck = stuckAlertAdminEmail({ transferId: ID, domain: 'northernlets.co.uk', method: 'tag', providerName: 'Namecheap', requestedAt: '2026-11-21T10:00:00Z', stuckDays: 5, panelUrl: PANEL });
  assert.ok(stuck.text.includes('21 November 2026') && stuck.text.includes('5 days') && stuck.text.includes('Mark moved'));
  const failed = exportFailedAdminEmail({ transferId: ID, siteName: 'Northern Lets', code: 'fetch_500', attempts: 3, panelUrl: PANEL });
  assert.ok(failed.text.includes('3 tries') && failed.text.includes('fetch_500') && failed.text.includes('Retry export'));
});

test('every value is escaped and a subject is one bounded line', () => {
  const evil = 'Evil <script>alert(1)</script>\r\nBcc: x@y.test "q"';
  const emails = [
    filesReadyEmail({ siteName: evil, guideText: '<b>guide</b>', attached: false, downloadUrl: 'https://x.test/?a="b"', ourCopyEnds: null, transferPageUrl: PAGE }),
    transferCodeEmail({ siteName: evil, domain: evil, code: '<i>CODE</i>', providerName: evil }),
    domainMovedEmail({ siteName: evil, domain: evil, ourCopyEnds: null, transferPageUrl: PAGE }),
    transferRequestedAdminEmail({ transferId: ID, siteName: evil, domain: evil, providerName: evil, method: 'tag', tag: evil, overlapEndsAt: null, panelUrl: PANEL }),
    manualStepAdminEmail({ transferId: ID, domain: evil, providerName: evil, step: 'tag', tag: evil, reason: evil, panelUrl: PANEL }),
    stuckAlertAdminEmail({ transferId: ID, domain: evil, method: 'tag', providerName: evil, requestedAt: null, stuckDays: 5, panelUrl: PANEL }),
    exportFailedAdminEmail({ transferId: ID, siteName: evil, code: evil, attempts: 3, panelUrl: PANEL }),
  ];
  for (const e of emails) {
    assert.ok(!e.html.includes('<script>') && !e.html.includes('<b>guide') && !e.html.includes('<i>CODE'), e.subject);
    assert.ok(!/[\r\n]/.test(e.subject) && e.subject.length <= 200, e.subject);
  }
});
