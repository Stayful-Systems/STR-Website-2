import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainAutoRenewEmail, domainLiveEmail, domainRenewalEmail, domainStuckEmail } from './domain.ts';

const live = { company: 'Harbour <b>Management</b>\r\nBcc: x@evil.test', address: 'https://harbourmanagement.co.uk/', oldAddress: 'https://stayful.co.uk/s/harbour', leadsUrl: 'https://stayful.co.uk/leads' };

test('the member email says the website is live at the address, mentions the old address and carries no price', () => {
  const e = domainLiveEmail(live);
  assert.equal(e.subject, 'Your website is live at https://harbourmanagement.co.uk/');
  assert.match(e.text, /https:\/\/harbourmanagement\.co\.uk\//);
  assert.match(e.text, /https:\/\/stayful\.co\.uk\/s\/harbour/);
  assert.match(e.html, /href="https:\/\/harbourmanagement\.co\.uk\/"/);
  assert.doesNotMatch(e.text + e.html, /£|\bpence\b|registrar/i);
  assert.match(e.text, /free for the first year/);
});

test('nothing a member typed can break a subject or a header, or land unescaped in the html', () => {
  const e = domainLiveEmail(live);
  assert.doesNotMatch(e.subject, /[\r\n]/);
  assert.doesNotMatch(e.html, /<b>Management<\/b>/);
  assert.match(e.html, /&lt;b&gt;/);
  const stuck = domainStuckEmail({ domain: 'a.co.uk\r\nBcc: x', status: 'connecting\n', hours: 25.4, panelUrl: 'https://stayful.co.uk/admin/management' });
  assert.doesNotMatch(stuck.subject, /[\r\n]/);
});

test('the admin emails name the domain, the state and the panel, never a price or an error body', () => {
  const stuck = domainStuckEmail({ domain: 'harbourmanagement.co.uk', status: 'connecting', hours: 26, panelUrl: 'https://stayful.co.uk/admin/management' });
  assert.match(stuck.subject, /harbourmanagement\.co\.uk/);
  assert.match(stuck.text, /over 26 hours/);
  assert.match(stuck.text, /admin\/management/);
  const renewal = domainRenewalEmail({ domain: 'harbourmanagement.co.uk', expires: '20 November 2027', days: 29.6, autoRenewOn: '13 November 2027', panelUrl: 'https://stayful.co.uk/admin/management' });
  assert.match(renewal.text, /expires on 20 November 2027 \(30 days\)/);
  assert.match(renewal.text, /renews on 13 November 2027 only if the website is live and not switched off/);
  for (const outcome of ['renewed', 'held', 'skipped'] as const) {
    const a = domainAutoRenewEmail({ domain: 'harbourmanagement.co.uk', outcome, reason: outcome === 'renewed' ? null : 'the website is switched off', panelUrl: 'https://stayful.co.uk/admin/management' });
    assert.match(a.subject, /harbourmanagement\.co\.uk/);
    assert.doesNotMatch(a.subject, /[\r\n]/);
  }
  assert.match(domainAutoRenewEmail({ domain: 'x.co.uk', outcome: 'renewed', reason: null, panelUrl: 'u' }).subject, /was renewed automatically/);
});
