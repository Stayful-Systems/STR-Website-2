import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { harness } from './test-store.ts';
import { renewalYear } from './purchase-server.ts';
import { OFFER_TTL_MS } from './types.ts';

const DAY = 86_400_000;

// ── Offers and choosing ──

test('offerNames: the primary then alternatives, available and priced, stored for the site', async () => {
  const h = harness();
  h.store.addSite({ id: 's1' });
  const r = await h.engine.offerNames({ websiteId: 's1' });
  assert.ok(r.ok);
  assert.equal(r.names[0], 'harbourmanagement.co.uk');
  assert.ok(r.names.length > 1 && r.names.length <= 6);
  assert.equal(r.prices['harbourmanagement.co.uk'], 600);
  assert.deepEqual((await h.store.getOffer('s1'))?.names, r.names);
});

test('offerNames leaves out taken, premium and too-dear names, and re-uses a fresh offer without asking again', async () => {
  const h = harness();
  h.store.addSite({ id: 's1' });
  h.registrar.taken.add('harbourmanagement.co.uk');
  h.registrar.premium.add('harbour-management.co.uk');
  h.registrar.prices.set('harbourleedsmanagement.co.uk', 2501);
  const r = await h.engine.offerNames({ websiteId: 's1' });
  assert.ok(r.ok);
  for (const n of ['harbourmanagement.co.uk', 'harbour-management.co.uk', 'harbourleedsmanagement.co.uk']) assert.ok(!r.names.includes(n), n);
  assert.ok(r.names.includes('harbourlettings.co.uk'));
  const calls = h.registrar.calls.check;
  const again = await h.engine.offerNames({ websiteId: 's1' });
  assert.ok(again.ok && !again.fresh);
  assert.equal(h.registrar.calls.check, calls, 'a fresh offer is not looked up again');
  await h.engine.offerNames({ websiteId: 's1' }, { refresh: true });
  assert.equal(h.registrar.calls.check, calls + 1);
});

test('offerNames: no registrar set up means no offer, and nothing is stored', async () => {
  const h = harness();
  h.store.addSite({ id: 's1' });
  h.deps.registrar = () => { throw new Error('not configured'); };
  const r = await h.engine.offerNames({ websiteId: 's1' });
  assert.deepEqual(r, { ok: false, reason: 'not_configured' });
  assert.equal(await h.store.getOffer('s1'), null);
});

test('a name that was not offered, or an offer older than 24 hours, is refused', async () => {
  const h = harness();
  h.store.addSite({ id: 's1' });
  assert.deepEqual(await h.engine.chooseName({ websiteId: 's1', name: 'harbourmanagement.co.uk' }), { ok: false, reason: 'not_offered' }, 'no offer at all');
  const offer = await h.engine.offerNames({ websiteId: 's1' });
  assert.ok(offer.ok);
  for (const bad of ['evil.co.uk', 'harbourmanagement.com', 'harbour.co.uk', '../x', 'www.harbourmanagement.co.uk']) {
    const r = await h.engine.chooseName({ websiteId: 's1', name: bad });
    assert.equal(r.ok, false, bad);
  }
  assert.equal(h.store.domains.size, 0);
  h.setNow(new Date(h.deps.now().getTime() + OFFER_TTL_MS + 1000));
  assert.deepEqual(await h.engine.chooseName({ websiteId: 's1', name: offer.names[0] }), { ok: false, reason: 'offer_expired' });
  assert.equal(h.store.domains.size, 0, 'nothing was created');
});

test('the choice is the site\'s own: another site\'s offer does not let a name through', async () => {
  const h = harness();
  h.store.addSite({ id: 's1', company: 'Harbour Management Ltd' });
  h.store.addSite({ id: 's2', company: 'Oak Lettings Ltd' });
  const o1 = await h.engine.offerNames({ websiteId: 's1' });
  await h.engine.offerNames({ websiteId: 's2' });
  assert.ok(o1.ok);
  assert.deepEqual(await h.engine.chooseName({ websiteId: 's2', name: o1.names[0] }), { ok: false, reason: 'not_offered' });
});

test('only a live site chooses; a name can be chosen once and not changed after (until needs_choice)', async () => {
  const h = harness();
  h.store.addSite({ id: 's1', status: 'preview' });
  await h.engine.offerNames({ websiteId: 's1' });
  assert.deepEqual(await h.engine.chooseName({ websiteId: 's1', name: 'harbourmanagement.co.uk' }), { ok: false, reason: 'not_live' });
  h.store.sites.get('s1')!.status = 'live';
  const first = await h.engine.chooseName({ websiteId: 's1', name: 'harbourmanagement.co.uk' });
  assert.ok(first.ok);
  assert.deepEqual(await h.engine.chooseName({ websiteId: 's1', name: 'harbourlettings.co.uk' }), { ok: false, reason: 'cannot_choose' });
});

test('a member cannot buy another domain after the admin released theirs', async () => {
  const h = harness();
  const { siteId, domainId } = await liveDomain(h);
  await h.engine.release(domainId);
  await h.engine.offerNames({ websiteId: siteId }, { refresh: true });
  assert.deepEqual(await h.engine.chooseName({ websiteId: siteId, name: 'harbourlettings.co.uk' }), { ok: false, reason: 'cannot_choose' });
});

test('two sites cannot hold the same name', async () => {
  const h = harness();
  h.store.addSite({ id: 's1' });
  h.store.addSite({ id: 's2' });
  await h.engine.offerNames({ websiteId: 's1' });
  await h.engine.offerNames({ websiteId: 's2' });
  assert.ok((await h.engine.chooseName({ websiteId: 's1', name: 'harbourmanagement.co.uk' })).ok);
  assert.deepEqual(await h.engine.chooseName({ websiteId: 's2', name: 'harbourmanagement.co.uk' }), { ok: false, reason: 'conflict' });
});

test('choosing records website_domain_chosen once per site; auto-buy off waits for the admin and spends nothing', async () => {
  const h = harness();
  const { siteId, domainId } = await h.chosen({ auto: false });
  assert.equal((await h.store.domain(domainId))?.status, 'awaiting_admin');
  assert.deepEqual(h.activity.map((a) => a.dedupeKey), [`website_domain_chosen:${siteId}`]);
  assert.equal(h.registrar.calls.register, 0);
  assert.equal(h.store.spend.size, 0);
  // The cron-style buy of an awaiting row does nothing while auto-buy is off ...
  const waiting = await h.engine.buy(domainId, {});
  assert.equal(waiting.outcome, 'waiting_admin');
  assert.equal(h.registrar.calls.register, 0);
  // ... and the admin's Buy goes ahead.
  const bought = await h.engine.buy(domainId, { admin: true });
  assert.equal(bought.outcome, 'registered');
  assert.equal(bought.status, 'connecting');
});

test('auto-buy on: choosing buys at once, once, owned by Stayful, auto-renew off', async () => {
  const h = harness();
  h.store.settingsNow.autoBuy = true;
  h.store.addSite({ id: 's1' });
  await h.engine.offerNames({ websiteId: 's1' });
  const r = await h.engine.chooseName({ websiteId: 's1', name: 'harbourmanagement.co.uk' });
  assert.ok(r.ok);
  assert.equal(r.status, 'connecting');
  assert.equal(h.registrar.calls.register, 1);
  const row = [...h.store.domains.values()][0];
  assert.equal(row.registrar, 'fake');
  assert.ok(row.registrarRef && row.boughtAt && row.expiresAt);
  assert.equal(h.registrar.owned.get('harbourmanagement.co.uk')?.autoRenew, false);
  assert.equal(h.store.spend.get(`register:${row.id}`)?.status, 'bought');
});

// ── Buying ──

test('a taken name gives needs_choice and fresh alternatives, with nothing spent', async () => {
  const h = harness();
  const { siteId, domainId, name } = await h.chosen();
  h.registrar.taken.add(name); // somebody bought it between the offer and now
  const r = await h.engine.buy(domainId, { admin: true });
  assert.equal(r.outcome, 'needs_choice');
  assert.equal(r.status, 'needs_choice');
  assert.equal(h.registrar.calls.register, 0);
  assert.equal(h.store.spend.size, 0, 'no money was even claimed');
  const offer = await h.store.getOffer(siteId);
  assert.ok(offer && offer.names.length > 0 && !offer.names.includes(name), 'fresh names, without the taken one');
  // The member picks again; the same row moves on with the new name.
  const again = await h.engine.chooseName({ websiteId: siteId, name: offer.names[0] });
  assert.ok(again.ok);
  assert.equal(h.store.domains.size, 1);
  assert.equal([...h.store.domains.values()][0].name, offer.names[0]);
});

test('a premium name, or one that has gone over the maximum price, is refused before any money moves', async () => {
  for (const change of [(h: ReturnType<typeof harness>, n: string) => h.registrar.premium.add(n), (h: ReturnType<typeof harness>, n: string) => h.registrar.prices.set(n, 2501)]) {
    const h = harness();
    const { domainId, name } = await h.chosen();
    change(h, name);
    const r = await h.engine.buy(domainId, { admin: true });
    assert.equal(r.outcome, 'needs_choice');
    assert.equal(h.registrar.calls.register, 0);
    assert.equal(h.store.spend.size, 0);
    assert.equal((await h.store.domain(domainId))?.lastError, 'price');
  }
});

test('an unclear timeout, then a retry, calls register exactly once and spends once', async () => {
  const h = harness();
  const { domainId, name } = await h.chosen();
  h.registrar.unclearOnNextRegister = 'after'; // the name WAS registered; we never saw the answer
  const first = await h.engine.buy(domainId, { admin: true });
  assert.equal(first.outcome, 'retry_later');
  assert.equal(first.status, 'registering');
  assert.equal(h.registrar.calls.register, 1);
  assert.equal(h.store.spend.get(`register:${domainId}`)?.status, 'claimed', 'the claim is kept');
  const second = await h.engine.buy(domainId, { admin: true });
  assert.equal(second.outcome, 'already_owned');
  assert.equal(second.status, 'connecting');
  assert.equal(h.registrar.calls.register, 1, 'the retry never registers again');
  assert.equal(h.store.spend.size, 1);
  assert.equal(h.store.spend.get(`register:${domainId}`)?.status, 'bought');
  assert.equal([...h.store.spend.values()].reduce((n, s) => n + (s.status !== 'void' ? s.pence : 0), 0), 600, 'spent once');
  assert.ok(h.registrar.owned.has(name));
});

test('an unclear timeout where nothing happened is retried through the ownership check, and the claim is not doubled', async () => {
  const h = harness();
  const { domainId } = await h.chosen();
  h.registrar.unclearOnNextRegister = 'before';
  assert.equal((await h.engine.buy(domainId, { admin: true })).outcome, 'retry_later');
  const second = await h.engine.buy(domainId, { admin: true });
  assert.equal(second.outcome, 'registered');
  assert.equal(h.registrar.calls.register, 2);
  assert.equal(h.store.spend.size, 1);
  assert.equal([...h.store.spend.values()][0].pence, 600);
});

test('three unclear failures in a row mark it failed; the admin Retry buys it', async () => {
  const h = harness();
  const { domainId } = await h.chosen();
  for (let i = 0; i < 3; i++) {
    h.registrar.failNext.set('findOwned', 'unclear');
    await h.engine.buy(domainId, { admin: true });
  }
  const row = await h.store.domain(domainId);
  assert.equal(row?.status, 'failed');
  assert.equal(row?.attempts, 3);
  assert.match(row?.lastError ?? '', /^registrar:unclear:504$/);
  assert.equal(h.registrar.calls.register, 0);
  const retried = await h.engine.buy(domainId, { admin: true });
  assert.equal(retried.outcome, 'registered');
});

test('the second purchase over the cap goes to held_cap, then buys the next day', async () => {
  const h = harness();
  h.store.settingsNow.dailySpendCapPence = 1000;
  h.registrar.defaultPricePence = 600;
  const a = await h.chosen({ company: 'Harbour Management Ltd' });
  const b = await h.chosen({ company: 'Oak Lettings Ltd' });
  assert.equal((await h.engine.buy(a.domainId, { admin: true })).outcome, 'registered');
  const held = await h.engine.buy(b.domainId, { admin: true });
  assert.equal(held.outcome, 'held_cap');
  assert.equal(held.status, 'held_cap');
  assert.equal(h.registrar.calls.register, 1);
  assert.equal(h.store.spend.get(`register:${b.domainId}`), undefined, 'nothing was claimed');
  // The next UK day the cap has room: simulate by voiding yesterday's spend from the day's count.
  h.store.spend.get(`register:${a.domainId}`)!.status = 'void';
  const next = await h.engine.buy(b.domainId, {});
  assert.equal(next.outcome, 'registered');
  assert.equal(h.registrar.calls.register, 2);
});

test('with the cap at £0 nothing is bought, and the buy holds', async () => {
  const h = harness();
  h.store.settingsNow.dailySpendCapPence = 0;
  const { domainId } = await h.chosen({ auto: true });
  assert.equal((await h.store.domain(domainId))?.status, 'held_cap');
  assert.equal(h.registrar.calls.register, 0);
});

test('two runners at once: only one registers, and the money is counted once', async () => {
  const h = harness();
  const { domainId } = await h.chosen();
  const [x, y] = await Promise.all([h.engine.buy(domainId, { admin: true }), h.engine.buy(domainId, { admin: true })]);
  assert.equal(h.registrar.calls.register, 1);
  assert.equal(h.store.spend.size, 1);
  assert.ok([x.outcome, y.outcome].includes('registered'));
});

test('no registrar, or no owner handle, buys nothing and changes nothing', async () => {
  const h = harness();
  const { domainId } = await h.chosen();
  const before = h.store.writes.length;
  h.deps.ownerHandle = () => null;
  assert.equal((await h.engine.buy(domainId, { admin: true })).outcome, 'not_configured');
  h.deps.ownerHandle = () => 'H';
  h.deps.registrar = () => { throw new Error('x'); };
  assert.equal((await h.engine.buy(domainId, { admin: true })).outcome, 'not_configured');
  assert.equal(h.store.writes.length, before);
});

test('a status that cannot be bought is refused', async () => {
  const h = harness();
  const { domainId } = await h.chosen();
  await h.engine.buy(domainId, { admin: true });
  assert.equal((await h.engine.buy(domainId, { admin: true })).outcome, 'bad_status');
  assert.equal(h.registrar.calls.register, 1);
});

// ── Connecting ──

test('advance: DNS from Vercel\'s recommended values, then Vercel root and www, then HTTPS, then live, with one email', async () => {
  const h = harness();
  const { domainId, name, siteId } = await h.chosen({ auto: true });
  h.vercel.config = { misconfigured: true, recommendedIPv4: ['203.0.113.7'], recommendedCNAME: 'abc.vercel-dns-017.com' };
  const first = await h.engine.advance(domainId);
  assert.equal(first.outcome, 'waiting');
  const row = (await h.store.domain(domainId))!;
  assert.ok(row.dnsSetAt && row.vercelAddedAt && !row.httpsOkAt);
  assert.deepEqual(h.registrar.dns.get(name), [
    { type: 'A', host: '@', value: '203.0.113.7' },
    { type: 'CNAME', host: 'www', value: 'abc.vercel-dns-017.com' },
  ]);
  assert.equal(h.vercel.domains.get(name), null);
  assert.equal(h.vercel.domains.get(`www.${name}`), name, 'www redirects to the root');
  assert.match(row.lastError ?? '', /^waiting: /);
  assert.equal(h.sent.length, 0);

  // DNS reaches Vercel: configured, verified, but HTTPS is not answering yet.
  h.vercel.config = { ...h.vercel.config, misconfigured: false };
  h.page.html = 'down';
  assert.equal((await h.engine.advance(domainId)).outcome, 'waiting');
  // ... and then it answers with a page that is not ours.
  h.page.html = '<h1>Parked</h1>';
  assert.equal((await h.engine.advance(domainId)).outcome, 'waiting');
  assert.equal((await h.store.domain(domainId))?.status, 'connecting');

  h.page.html = 'auto';
  const done = await h.engine.advance(domainId);
  assert.equal(done.outcome, 'live');
  assert.equal(done.status, 'live');
  assert.equal(h.probes.at(-1), `https://${name}/`);
  assert.equal(h.store.sites.get(siteId)?.domain, name);
  const live = (await h.store.domain(domainId))!;
  assert.ok(live.httpsOkAt && live.liveAt);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].key, `domain-live:${domainId}`);
  assert.equal(h.sent[0].address, `https://${name}/`);
  assert.match(h.sent[0].oldAddress, /\/s\/slug-site-1$/);
  // The DNS and Vercel steps were not repeated.
  assert.equal(h.registrar.calls.setDns, 1);
  assert.equal(h.vercel.log.filter((l) => l.startsWith('addDomain:')).length, 1);
});

test('advance resumes from its timestamps and an unclear Vercel error counts an attempt, then fails after three', async () => {
  const h = harness();
  const { domainId } = await h.chosen({ auto: true });
  for (let i = 0; i < 3; i++) {
    h.vercel.failNext.set('domainConfig', 'unclear');
    await h.engine.advance(domainId);
  }
  const row = await h.store.domain(domainId);
  assert.equal(row?.status, 'failed');
  assert.match(row?.lastError ?? '', /^vercel:unclear:504$/);
  assert.equal(h.registrar.calls.setDns, 0);
});

test('advance with no recommended values from Vercel waits and retries; nothing is typed in', async () => {
  const h = harness();
  const { domainId } = await h.chosen({ auto: true });
  h.vercel.config = { misconfigured: true, recommendedIPv4: [], recommendedCNAME: null };
  const r = await h.engine.advance(domainId);
  assert.equal(r.outcome, 'retry_later');
  assert.equal(h.registrar.calls.setDns, 0);
});

test('a live email that fails is flagged and sent again later, once', async () => {
  const h = harness();
  const { domainId } = await h.chosen({ auto: true });
  h.vercel.config = { ...h.vercel.config, misconfigured: false };
  h.deps.sendLiveEmail = async (i) => { h.sent.push(i); return false; };
  assert.equal((await h.engine.advance(domainId)).status, 'live');
  assert.equal((await h.store.domain(domainId))?.lastError, 'email_not_sent');
  h.deps.sendLiveEmail = async (i) => { h.sent.push(i); return true; };
  assert.equal((await h.engine.resendLiveEmail(domainId)).outcome, 'email_sent');
  assert.equal((await h.store.domain(domainId))?.lastError, null);
  assert.equal((await h.engine.resendLiveEmail(domainId)).outcome, 'nothing_to_send');
  assert.ok(h.sent.every((s) => s.key === `domain-live:${domainId}`), 'the same key every time: Resend sends it once');
});

// ── Releasing ──

async function liveDomain(h: ReturnType<typeof harness>) {
  const d = await h.chosen({ auto: true });
  h.vercel.config = { ...h.vercel.config, misconfigured: false };
  await h.engine.advance(d.domainId);
  assert.equal((await h.store.domain(d.domainId))?.status, 'live');
  return d;
}

test('release calls Vercel remove before the registrar setAutoRenew(false), clears the site address, and keeps the name until expiry', async () => {
  const h = harness();
  const { domainId, name, siteId } = await liveDomain(h);
  h.registrar.log.length = 0;
  h.vercel.log.length = 0;
  const r = await h.engine.release(domainId);
  assert.equal(r.outcome, 'released');
  assert.deepEqual(h.vercel.log, [`removeDomain:www.${name}`, `removeDomain:${name}`]);
  assert.deepEqual(h.registrar.log, [`setAutoRenew:${name}:false`]);
  assert.equal(h.store.sites.get(siteId)?.domain, null);
  assert.equal((await h.store.domain(domainId))?.status, 'released');
  assert.ok(h.registrar.owned.has(name), 'a .co.uk cannot be refunded: we still own it');
  assert.equal(h.registrar.owned.get(name)?.autoRenew, false);
});

test('release stops if Vercel fails: the registrar is not touched and the site keeps its address', async () => {
  const h = harness();
  const { domainId, siteId } = await liveDomain(h);
  h.registrar.log.length = 0;
  h.vercel.failNext.set('removeDomain', 'refused');
  const r = await h.engine.release(domainId);
  assert.equal(r.outcome, 'vercel_failed');
  assert.deepEqual(h.registrar.log, []);
  assert.ok(h.store.sites.get(siteId)?.domain);
  const row = await h.store.domain(domainId);
  assert.equal(row?.status, 'releasing');
  assert.match(row?.lastError ?? '', /^vercel:refused:400$/);
  // Running it again finishes the job.
  assert.equal((await h.engine.release(domainId)).outcome, 'released');
});

test('releasing a domain nothing was bought for just cancels it, with no registrar or Vercel call', async () => {
  const h = harness();
  const { domainId } = await h.chosen();
  const r = await h.engine.release(domainId);
  assert.equal(r.outcome, 'released');
  assert.equal(h.registrar.calls.register + h.registrar.calls.setAutoRenew, 0);
  assert.equal(h.vercel.log.length, 0);
});

// ── Renewing and the yearly charge ──

test('renew: claims the spend, renews a year on, and with the charge OFF never calls the charge', async () => {
  const h = harness();
  const { domainId } = await liveDomain(h);
  const before = (await h.store.domain(domainId))!.expiresAt!;
  h.store.settingsNow.chargeOn = false;
  const r = await h.engine.renew(domainId);
  assert.equal(r.outcome, 'renewed');
  assert.equal(h.store.charges.length, 0);
  assert.equal(h.store.writes.filter((w) => w === 'charge').length, 0);
  const after = (await h.store.domain(domainId))!;
  assert.ok(new Date(after.expiresAt!).getTime() > new Date(before).getTime() + 300 * DAY);
  assert.equal(h.store.spend.get(`renew:${domainId}:${before.slice(0, 10)}`)?.status, 'bought');
});

test('renew with the charge ON charges year 2 once, for the domain\'s cost, and a repeat never double charges', async () => {
  const h = harness();
  const { domainId } = await liveDomain(h);
  h.store.settingsNow.chargeOn = true;
  const row = (await h.store.domain(domainId))!;
  const r = await h.engine.renew(domainId);
  assert.equal(r.outcome, 'renewed_charged');
  assert.deepEqual(h.store.charges, [{ owner: row.ownerId, domain: domainId, period: row.expiresAt!.slice(0, 10), pence: 600 }]);
  // The same period again (e.g. the cron ran twice): the guard answers already_charged.
  await h.store.updateDomain(domainId, { expiresAt: row.expiresAt });
  h.store.spend.get(`renew:${domainId}:${row.expiresAt!.slice(0, 10)}`)!.status = 'void';
  await h.engine.renew(domainId);
  assert.equal(h.store.charges.length, 1);
});

test('registration never charges: year 1 is free whatever the setting', async () => {
  const h = harness();
  h.store.settingsNow.chargeOn = true;
  h.store.settingsNow.autoBuy = true;
  h.store.addSite({ id: 's1' });
  await h.engine.offerNames({ websiteId: 's1' });
  await h.engine.chooseName({ websiteId: 's1', name: 'harbourmanagement.co.uk' });
  assert.equal(h.store.charges.length, 0);
  assert.equal(h.store.writes.filter((w) => w === 'charge').length, 0);
  assert.equal(renewalYear(null, '2027-11-20T00:00:00Z'), 2);
  assert.equal(renewalYear('2026-11-20T00:00:00Z', '2027-11-20T00:00:00Z'), 2);
  assert.equal(renewalYear('2026-11-20T00:00:00Z', '2028-11-20T00:00:00Z'), 3);
});

test('a renewal over the cap holds; a renewal the registrar refuses frees its claim', async () => {
  const h = harness();
  const { domainId } = await liveDomain(h);
  h.store.settingsNow.dailySpendCapPence = 600; // the registration already used the day's £6
  assert.equal((await h.engine.renew(domainId)).outcome, 'held_cap');
  h.store.settingsNow.dailySpendCapPence = 5000;
  h.registrar.failNext.set('renew', 'refused');
  const r = await h.engine.renew(domainId);
  assert.equal(r.outcome, 'retry_later');
  const key = [...h.store.spend.keys()].find((k) => k.startsWith('renew:'))!;
  assert.equal(h.store.spend.get(key)?.status, 'void');
});

test('a renewal that went through unseen is recorded, not renewed twice', async () => {
  const h = harness();
  const { domainId, name } = await liveDomain(h);
  h.registrar.failNext.set('renew', 'unclear');
  assert.equal((await h.engine.renew(domainId)).outcome, 'retry_later');
  // Behind the scenes it did renew.
  const o = h.registrar.owned.get(name)!;
  o.expiresAt = new Date(new Date(o.expiresAt).getTime() + 366 * DAY).toISOString();
  const renewCalls = h.registrar.calls.renew;
  const r = await h.engine.renew(domainId);
  assert.equal(r.outcome, 'renewed');
  assert.equal(h.registrar.calls.renew, renewCalls, 'no second renew call');
  assert.equal((await h.store.domain(domainId))?.expiresAt, o.expiresAt);
});

test('decideRenewal records the admin\'s choice, and a renewal clears it for the next year', async () => {
  const h = harness();
  const { domainId } = await liveDomain(h);
  const d = await h.engine.decideRenewal(domainId, 'dont_renew', 'admin-1');
  assert.equal(d.outcome, 'dont_renew');
  const row = (await h.store.domain(domainId))!;
  assert.equal(row.renewDecision, 'dont_renew');
  assert.equal(row.renewDecidedBy, 'admin-1');
  await h.engine.decideRenewal(domainId, 'renew', 'admin-1');
  await h.engine.renew(domainId);
  assert.equal((await h.store.domain(domainId))?.renewDecision, null);
});

test('blockRenewal (Batch 36\'s hook) stops the auto-renew rule for that site', async () => {
  const h = harness();
  const { domainId, siteId } = await liveDomain(h);
  await h.store.updateDomain(domainId, { expiresAt: new Date(h.deps.now().getTime() + 3 * DAY).toISOString() });
  assert.equal(await h.engine.autoRenewVerdict((await h.store.domain(domainId))!), 'renew');
  assert.deepEqual(await h.engine.blockRenewal(siteId), { ok: true, changed: true, dryRun: false });
  assert.equal(await h.engine.autoRenewVerdict((await h.store.domain(domainId))!), 'skip_not_allowed');
  assert.deepEqual(await h.engine.blockRenewal(siteId), { ok: true, changed: false, dryRun: false });
  assert.deepEqual(await h.engine.blockRenewal('no-such-site'), { ok: true, changed: false, dryRun: false });
  // A site switched off is not renewed either.
  h.store.sites.get(siteId)!.status = 'paused';
  await h.store.updateDomain(domainId, { renewAllowed: true });
  assert.equal(await h.engine.autoRenewVerdict((await h.store.domain(domainId))!), 'skip_site_off');
});

// ── Dry runs ──

test('a dry run of every function writes nothing and calls no write, no registrar, no Vercel and no email', async () => {
  const h = harness();
  const { domainId, siteId } = await liveDomain(h);
  const other = await h.chosen({ company: 'Oak Lettings Ltd' }); // an awaiting row for buy
  const conn = await h.chosen({ company: 'Pine Homes Ltd', auto: true }); // a connecting row for advance
  h.store.addSite({ id: 'fresh', company: 'Birch Lettings Ltd' });
  await h.engine.offerNames({ websiteId: 'fresh' });

  const snapshot = () => JSON.stringify({ d: [...h.store.domains.entries()], s: [...h.store.spend.entries()], o: [...h.store.offers.entries()], si: [...h.store.sites.entries()], c: h.store.charges });
  const before = snapshot();
  const writes = h.store.writes.length;
  const reg = { ...h.registrar.calls };
  const vlog = h.vercel.log.length;
  const sent = h.sent.length;
  const act = h.activity.length;

  const results = [
    await h.engine.offerNames({ websiteId: 'fresh' }, { refresh: true, dryRun: true }),
    await h.engine.chooseName({ websiteId: 'fresh', name: 'birchlettings.co.uk' }, { dryRun: true }),
    await h.engine.buy(other.domainId, { dryRun: true, admin: true }),
    await h.engine.advance(conn.domainId, { dryRun: true }),
    await h.engine.release(domainId, { dryRun: true }),
    await h.engine.renew(domainId, { dryRun: true }),
    await h.engine.decideRenewal(domainId, 'renew', 'a', { dryRun: true }),
    await h.engine.blockRenewal(siteId, { dryRun: true }),
  ];
  assert.equal(snapshot(), before, 'nothing in the store changed');
  assert.equal(h.store.writes.length, writes);
  assert.deepEqual(h.registrar.calls, reg, 'no registrar call at all');
  assert.equal(h.vercel.log.length, vlog, 'no Vercel call at all');
  assert.equal(h.sent.length, sent);
  assert.equal(h.activity.length, act);
  assert.ok(results.every((r) => ('dryRun' in r ? r.dryRun === true : false)), 'every result says it was a dry run');
  for (const r of results.slice(2, 6)) assert.ok('steps' in r && (r.steps?.length ?? 0) > 0, 'a dry run shows the steps');
  const buy = results[2] as { costPence?: number | null };
  assert.equal(buy.costPence, 600, 'and the cost');
});

// ── Source pins ──

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('the charge RPC is reachable from one function, which returns early when the charge is OFF', () => {
  const engine = read('./purchase-server.ts');
  assert.equal([...engine.matchAll(/store\.charge\(/g)].length, 1, 'store.charge is called once');
  const fn = engine.slice(engine.indexOf('async function chargeRenewal'), engine.indexOf('async function renew('));
  assert.ok(fn.includes('store.charge('));
  assert.ok(fn.indexOf("if (!settings.chargeOn) return 'off';") !== -1 && fn.indexOf("if (!settings.chargeOn) return 'off';") < fn.indexOf('store.charge('), 'the OFF return comes first');
  // Nothing at registration or in buy() reaches it.
  const buy = engine.slice(engine.indexOf('async function buy('), engine.indexOf('// ── Connecting ──'));
  assert.doesNotMatch(buy, /chargeRenewal|store\.charge/);
  // And only renew() calls chargeRenewal.
  assert.equal([...engine.matchAll(/chargeRenewal\(/g)].length, 2, 'the definition and one call');
});

test('the engine logs nothing, imports only from src/lib (no server-only, no network of its own)', () => {
  const engine = read('./purchase-server.ts');
  assert.doesNotMatch(engine, /console\./);
  assert.doesNotMatch(engine, /\bfetch\(/);
  assert.doesNotMatch(engine, /^import 'server-only'/m);
  for (const m of engine.matchAll(/^import .* from '([^']+)'/gm)) assert.match(m[1], /^\.\.?\//, m[1]);
});

test('errors are stored as a code and a status only, 200 characters at most, credentials stripped', async () => {
  const { errorText } = await import('./purchase-server.ts');
  const { RegistrarError } = await import('./registrar/types.ts');
  assert.equal(errorText(new RegistrarError('unclear', 504)), 'registrar:unclear:504');
  assert.equal(errorText(new Error('Bearer abcdefghijklmnopqrstuvwxyz0123456789 password=hunter2')), 'error');
  assert.ok(errorText(new RegistrarError('refused')).length <= 200);
});
