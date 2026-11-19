import { test } from 'node:test';
import assert from 'node:assert/strict';
import { academyRefundEmail, academyReminderEmail } from './emails.ts';
import { ACADEMY_FACTS } from './rules.ts';

const CANCEL = 'https://intel.example.com/api/billing/academy/cancel?t=sub_123.1802000000.abc';

test('reminder: subject and body are the agreed wording, word for word', () => {
  const mail = academyReminderEmail({
    date: new Date('2027-02-19T10:00:00Z'),
    amount: '£39.99',
    last4: '4242',
    cancelUrl: CANCEL,
    months: ACADEMY_FACTS.trialMonths,
    siteUrl: 'https://intel.example.com/',
  });
  assert.equal(mail.subject, 'Your free Academy months end on 19 February 2027');
  const body = `Your 3 free months of Stayful Intelligence Pro end on 19 February 2027. From then it's £39.99/month on your card ending 4242. Nothing to do if you'd like to keep it. To cancel, tap here: ${CANCEL}.`;
  assert.equal(mail.text.split('\n')[0], body);
  assert.ok(mail.text.endsWith('Stayful Intelligence'));
  assert.ok(!/unsubscribe/i.test(mail.text + mail.html), 'a billing notice carries no unsubscribe');
  // The html carries the same words, and the link is a real link.
  assert.ok(mail.html.includes(`<a href="${CANCEL}"`));
  assert.ok(mail.html.includes('Your 3 free months of Stayful Intelligence Pro end on 19 February 2027.'));
  assert.ok(mail.html.includes("From then it's £39.99/month on your card ending 4242. Nothing to do if you'd like to keep it. To cancel, tap here: <a"));
});

test('reminder: the months and amount come from the inputs; the date is UK style from an ISO string too', () => {
  const mail = academyReminderEmail({ date: '2027-11-03T23:30:00Z', amount: '£44.00', last4: '0005', cancelUrl: CANCEL, months: 4, siteUrl: 'https://x.test' });
  assert.equal(mail.subject, 'Your free Academy months end on 3 November 2027');
  assert.ok(mail.text.startsWith("Your 4 free months of Stayful Intelligence Pro end on 3 November 2027. From then it's £44.00/month on your card ending 0005."));
});

test('reminder: defaults to the trial months in ACADEMY_FACTS', () => {
  const mail = academyReminderEmail({ date: '2027-02-19T10:00:00Z', amount: '£39.99', last4: '4242', cancelUrl: CANCEL, siteUrl: 'https://x.test' });
  assert.ok(mail.text.startsWith(`Your ${ACADEMY_FACTS.trialMonths} free months`));
});

test('reminder: everything is escaped in the html', () => {
  const mail = academyReminderEmail({
    date: '2027-02-19T10:00:00Z',
    amount: '<b>£1</b>',
    last4: '"><script>',
    cancelUrl: 'https://x.test/c?a=1&b="2"<x>',
    siteUrl: 'https://x.test',
  });
  assert.ok(!mail.html.includes('<script>'));
  assert.ok(!mail.html.includes('<b>'));
  assert.ok(mail.html.includes('&lt;b&gt;£1&lt;/b&gt;'));
  assert.ok(mail.html.includes('href="https://x.test/c?a=1&amp;b=&quot;2&quot;&lt;x&gt;"'));
  // The text is plain, unescaped.
  assert.ok(mail.text.includes('https://x.test/c?a=1&b="2"<x>.'));
});

test('refund email is unchanged', () => {
  const mail = academyRefundEmail({ siteUrl: 'https://x.test' });
  assert.equal(mail.subject, 'Your Academy refund');
  assert.ok(mail.text.startsWith('Your Stayful Academy purchase has been refunded'));
});
