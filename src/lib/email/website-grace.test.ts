import { test } from 'node:test';
import assert from 'node:assert/strict';
import { longDay, renderWebsiteGraceEmail, websiteGraceWarningCopy, websiteSwitchedOffCopy } from './website-grace.ts';
import { SWITCHES_BEHIND } from '../notify/cap.ts';

const BASE = 'https://app.example.test';

test('long dates read in plain English', () => {
  assert.equal(longDay('2026-11-20'), '20 November 2026');
  assert.equal(longDay('2027-01-05'), '5 January 2027');
  assert.equal(longDay('not-a-date'), 'not-a-date');
});

test('the warning gives the switch-off date and one tap to keep the site, by reason', () => {
  const a = websiteGraceWarningCopy({ reason: 'abandoned', switchOffOn: '2026-12-20', daysLeft: 30 });
  assert.match(a.subject, /20 December 2026/);
  assert.match(a.title, /in 30 days, on 20 December 2026/);
  assert.ok(a.lines.some((l) => /just log in/.test(l)), 'keeping an abandoned site means logging in');
  assert.equal(a.cta.label, 'Keep my website');
  assert.equal(a.cta.path, '/leads/website');
  const c = websiteGraceWarningCopy({ reason: 'cancelled', switchOffOn: '2026-12-20', daysLeft: 14 });
  assert.ok(c.lines.some((l) => /plan has ended/.test(l)));
  assert.equal(c.cta.path, '/upgrade');
  const u = websiteGraceWarningCopy({ reason: 'unpaid', switchOffOn: '2026-12-20', daysLeft: 3 });
  assert.ok(u.lines.some((l) => /outstanding charge/.test(l)));
  assert.equal(u.cta.path, '/account/billing');
});

test('the last-day wording is "tomorrow" or "today", never "in 1 days"', () => {
  assert.match(websiteGraceWarningCopy({ reason: 'abandoned', switchOffOn: '2026-12-20', daysLeft: 1 }).title, /tomorrow/);
  assert.match(websiteGraceWarningCopy({ reason: 'abandoned', switchOffOn: '2026-12-20', daysLeft: 0 }).title, /today/);
  assert.doesNotMatch(websiteGraceWarningCopy({ reason: 'abandoned', switchOffOn: '2026-12-20', daysLeft: 1 }).title, /1 days/);
});

test('the switched-off email says what happened, what is kept, and until when it can be switched back on', () => {
  const c = websiteSwitchedOffCopy({ reason: 'abandoned', deleteOn: '2027-03-20' });
  assert.equal(c.subject, 'Your Stayful website has been switched off');
  const body = c.lines.join(' ');
  assert.match(body, /no longer available/);
  assert.match(body, /leads, their reports and your account are not affected/);
  assert.match(body, /until 20 March 2027/);
  assert.match(body, /settings, pages and uploaded files/);
  assert.equal(c.cta.label, 'Switch my website back on');
});

test('both are service notices: capped, no unsubscribe, no notification settings footer', () => {
  assert.deepEqual(SWITCHES_BEHIND.website_grace, []);
  for (const copy of [websiteGraceWarningCopy({ reason: 'abandoned', switchOffOn: '2026-12-20', daysLeft: 30 }), websiteSwitchedOffCopy({ reason: 'unpaid', deleteOn: '2027-03-20' })]) {
    const r = renderWebsiteGraceEmail(copy, BASE);
    assert.doesNotMatch(r.html, /Manage notifications|unsubscribe/i);
    assert.doesNotMatch(r.text, /Manage notifications|unsubscribe/i);
    assert.match(r.html, /Billing &amp; usage/);
    assert.match(r.text, /service notice/);
    assert.ok(r.html.includes(`${BASE}${copy.cta.path}`), 'the button links to the app');
    assert.ok(r.text.includes(`${copy.cta.label}: ${BASE}${copy.cta.path}`));
  }
});

test('the copy holds no money figure and nothing from the member\'s site', () => {
  for (const copy of [websiteGraceWarningCopy({ reason: 'unpaid', switchOffOn: '2026-12-20', daysLeft: 14 }), websiteSwitchedOffCopy({ reason: 'cancelled', deleteOn: '2027-03-20' })]) {
    assert.doesNotMatch([copy.subject, copy.title, ...copy.lines].join(' '), /£|\bpence\b/);
  }
});

test('the renderer escapes what it is given', () => {
  const r = renderWebsiteGraceEmail({ subject: 's', title: '<b>x</b>', lines: ['a & b'], cta: { label: '"go"', path: '/x' } }, BASE);
  assert.match(r.html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(r.html, /a &amp; b/);
  assert.match(r.html, /&quot;go&quot;/);
});
