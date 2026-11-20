import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creditIdleFinalWarningCopy, creditIdleReminderCopy, renderCreditIdleEmail } from './credit-idle.ts';

const BASE = 'https://example.test';

test('the reminder states the balance and that plan credit rolls over while any spending keeps it', () => {
  const c = creditIdleReminderCopy({ months: 3, balancePence: 3850 });
  assert.match(c.subject, /£38\.50/);
  const all = c.lines.join(' ');
  assert.match(all, /£38\.50/);
  assert.match(all, /3 months/);
  assert.match(all, /rolls over/);
  assert.match(all, /any spending/);
  assert.equal(c.billingNotice, false);
  // No expiry wording in a reminder.
  assert.doesNotMatch(all, /expire/i);
  const e = renderCreditIdleEmail(c, BASE);
  // Behind the credit alerts switch: it carries the notification settings link.
  assert.match(e.html, /Manage notifications/);
  assert.match(e.text, /Manage notifications: https:\/\/example\.test\/account\/notifications/);
});

test('the final warning states the balance, the amount and the date that would expire', () => {
  const c = creditIdleFinalWarningCopy({ balancePence: 5700, expiringPence: 3800, expiresOn: '2027-12-20T06:43:00Z', months: 12 });
  assert.match(c.subject, /£38\.00/);
  assert.match(c.subject, /20 December 2027/);
  const all = c.lines.join(' ');
  assert.match(all, /£57\.00/);
  assert.match(all, /£38\.00/);
  assert.match(all, /20 December 2027/);
  assert.match(all, /12 months/);
  assert.match(all, /earlier months/);
  assert.match(all, /latest month's plan credit never expires/);
  assert.match(all, /Spending any credit before 20 December 2027/);
});

test('the final warning is a billing notice: no opt-out footer that implies it can be switched off', () => {
  const c = creditIdleFinalWarningCopy({ balancePence: 5700, expiringPence: 3800, expiresOn: new Date('2027-12-20T06:43:00Z') });
  assert.equal(c.billingNotice, true);
  assert.match(c.lines.join(' '), /billing notice/);
  const e = renderCreditIdleEmail(c, BASE);
  assert.doesNotMatch(e.html, /Manage notifications|unsubscribe/i);
  assert.doesNotMatch(e.text, /Manage notifications|unsubscribe/i);
  assert.match(e.html, /Billing &amp; usage/);
  assert.doesNotMatch(e.text, /null|undefined/);
  // With no months given it still reads sensibly.
  assert.match(c.lines[0], /for a long time/);
});

test('rendered emails escape the copy and link to the site', () => {
  const e = renderCreditIdleEmail({ ...creditIdleReminderCopy({ months: 6, balancePence: 100 }), title: '<b>x</b>' }, BASE);
  assert.match(e.html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(e.html, /https:\/\/example\.test\/today/);
  assert.match(e.text, /https:\/\/example\.test\/today/);
});
