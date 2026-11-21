import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createOpenprovider } from './openprovider.ts';
import { RegistrarError } from './types.ts';

const PASSWORD = 'p4ss-SECRET-word';
const TOKEN = 'tok-SECRET-1234';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}
type Handler = (call: Call, n: number) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const loginOk = (token = TOKEN) => json(200, { code: 0, data: { token, reseller_id: 1 } });

/** A mock fetch: logins are answered automatically unless the handler wants them. */
function mockFetch(handler: Handler, opts: { autoLogin?: boolean } = {}) {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    if (opts.autoLogin !== false && call.url.endsWith('/auth/login')) return loginOk();
    return handler(call, calls.length);
  }) as typeof fetch;
  return { f, calls, api: () => calls.filter((c) => !c.url.endsWith('/auth/login')) };
}

function client(handler: Handler, extra: { sandbox?: boolean; timeoutMs?: number; autoLogin?: boolean } = {}) {
  const m = mockFetch(handler, { autoLogin: extra.autoLogin });
  const reg = createOpenprovider({ username: 'user@example.com', password: PASSWORD, sandbox: extra.sandbox ?? false, fetch: m.f, timeoutMs: extra.timeoutMs });
  return { reg, ...m };
}

async function rejects(p: Promise<unknown>, code: string, status: number | null) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof RegistrarError, 'a RegistrarError');
    assert.equal(e.code, code);
    assert.equal(e.status, status);
    return true;
  });
}

const checkRow = (domain: string, over: Record<string, unknown> = {}) => ({
  domain,
  status: 'free',
  is_premium: false,
  premium: { currency: 'GBP', price: { create: 0 } },
  price: { product: { currency: 'GBP', price: 7.5 }, reseller: { currency: 'GBP', price: 6.1 } },
  reason: '',
  ...over,
});

const domainRec = (over: Record<string, unknown> = {}) => ({
  id: 4242,
  domain: { name: 'acme', extension: 'co.uk' },
  autorenew: 'off',
  renewal_date: '2027-11-20 10:30:00',
  expiration_date: '2027-11-21 00:00:00',
  ...over,
});

// ---- hosts, login, token ----------------------------------------------------

test('production host is used when sandbox is false', async () => {
  const c = client(() => json(200, { code: 0, data: { results: [] } }));
  await c.reg.findOwned('acme.co.uk');
  assert.ok(c.calls.length >= 2);
  for (const call of c.calls) assert.ok(call.url.startsWith('https://api.openprovider.eu/v1/'), call.url);
});

test('sandbox host is used (login and calls) when sandbox is true', async () => {
  const c = client(() => json(200, { code: 0, data: { results: [] } }), { sandbox: true });
  await c.reg.findOwned('acme.co.uk');
  assert.ok(c.calls.length >= 2);
  for (const call of c.calls) assert.ok(call.url.startsWith('https://api.sandbox.openprovider.eu/v1/'), call.url);
});

test('login posts credentials once, the bearer token is cached and sent', async () => {
  const c = client(() => json(200, { code: 0, data: { results: [] } }));
  await c.reg.findOwned('acme.co.uk');
  await c.reg.findOwned('other.co.uk');
  const logins = c.calls.filter((x) => x.url.endsWith('/auth/login'));
  assert.equal(logins.length, 1);
  assert.deepEqual(logins[0].body, { username: 'user@example.com', password: PASSWORD, ip: '0.0.0.0' });
  assert.equal(logins[0].headers.authorization, undefined);
  for (const call of c.api()) assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
});

test('a 401 re-logs in once and retries the call', async () => {
  let logins = 0;
  const seen: string[] = [];
  const m = mockFetch(
    (call) => {
      if (call.url.endsWith('/auth/login')) return loginOk(`t${++logins}`);
      seen.push(call.headers.authorization);
      return call.headers.authorization === 'Bearer t1' ? json(401, { code: 196, desc: 'expired' }) : json(200, { code: 0, data: { results: [] } });
    },
    { autoLogin: false },
  );
  const reg = createOpenprovider({ username: 'u', password: PASSWORD, sandbox: false, fetch: m.f });
  assert.equal(await reg.findOwned('acme.co.uk'), null);
  assert.equal(logins, 2);
  assert.deepEqual(seen, ['Bearer t1', 'Bearer t2']);
});

test('a second 401 is refused 401 and only one re-login happens', async () => {
  let logins = 0;
  const m = mockFetch(
    (call) => (call.url.endsWith('/auth/login') ? loginOk(`t${++logins}`) : json(401, { code: 196, desc: 'nope' })),
    { autoLogin: false },
  );
  const reg = createOpenprovider({ username: 'u', password: PASSWORD, sandbox: false, fetch: m.f });
  await rejects(reg.findOwned('acme.co.uk'), 'refused', 401);
  assert.equal(logins, 2);
});

test('bad credentials: login 401 is refused, login 500 is unclear', async () => {
  const m1 = mockFetch(() => json(401, { code: 191, desc: 'Authentication error' }), { autoLogin: false });
  await rejects(createOpenprovider({ username: 'u', password: PASSWORD, sandbox: false, fetch: m1.f }).findOwned('acme.co.uk'), 'refused', 401);
  const m2 = mockFetch(() => json(500, {}), { autoLogin: false });
  await rejects(createOpenprovider({ username: 'u', password: PASSWORD, sandbox: false, fetch: m2.f }).findOwned('acme.co.uk'), 'unclear', 500);
});

test('a login reply without a token is unclear', async () => {
  const m = mockFetch(() => json(200, { code: 0, data: {} }), { autoLogin: false });
  await rejects(createOpenprovider({ username: 'u', password: PASSWORD, sandbox: false, fetch: m.f }).findOwned('acme.co.uk'), 'unclear', 200);
});

// ---- failure mapping --------------------------------------------------------

test('a timeout is unclear, never taken', async () => {
  // Never answers; rejects only when the abort signal fires, like the real fetch.
  const hang = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/auth/login')) return loginOk();
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  }) as typeof fetch;
  const reg = createOpenprovider({ username: 'u', password: PASSWORD, sandbox: false, fetch: hang, timeoutMs: 20 });
  await rejects(reg.register('acme.co.uk', { ownerHandle: 'H-1' }), 'unclear', null);
  await rejects(reg.check(['acme.co.uk']), 'unclear', null);
});

test('a network error is unclear', async () => {
  const boom = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/auth/login')) return loginOk();
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  const reg = createOpenprovider({ username: 'u', password: PASSWORD, sandbox: false, fetch: boom });
  await rejects(reg.register('acme.co.uk', { ownerHandle: 'H-1' }), 'unclear', null);
});

test('any 5xx is unclear with the status', async () => {
  for (const status of [500, 502, 503]) {
    const c = client(() => json(status, { code: 1, desc: 'boom' }));
    await rejects(c.reg.register('acme.co.uk', { ownerHandle: 'H-1' }), 'unclear', status);
    await rejects(c.reg.check(['acme.co.uk']), 'unclear', status);
  }
});

test('a 4xx is refused with the status', async () => {
  const c = client(() => json(400, { code: 1, desc: 'Invalid input' }));
  await rejects(c.reg.check(['acme.co.uk']), 'refused', 400);
  await rejects(c.reg.register('acme.co.uk', { ownerHandle: 'H-1' }), 'refused', 400);
  await rejects(c.reg.findOwned('acme.co.uk'), 'refused', 400);
});

test('maintenance mode is unclear', async () => {
  const c = client(() => json(200, { code: 0, maintenance: true, data: {} }));
  await rejects(c.reg.check(['acme.co.uk']), 'unclear', 200);
});

// ---- check ------------------------------------------------------------------

test('check maps results in the order given, with pence, premium and unavailable', async () => {
  const c = client(() =>
    json(200, {
      code: 0,
      data: {
        results: [
          checkRow('b.co.uk', { status: 'active', price: {} }),
          checkRow('a.co.uk'),
          checkRow('c.co.uk', { is_premium: true, premium: { currency: 'GBP', price: { create: 1234.5 } } }),
        ],
      },
    }),
  );
  const out = await c.reg.check(['a.co.uk', 'b.co.uk', 'c.co.uk']);
  assert.deepEqual(out, [
    { name: 'a.co.uk', available: true, premium: false, pricePence: 610 },
    { name: 'b.co.uk', available: false, premium: false, pricePence: null },
    { name: 'c.co.uk', available: true, premium: true, pricePence: 123450 },
  ]);
  const req = c.api()[0];
  assert.equal(req.method, 'POST');
  assert.ok(req.url.endsWith('/domains/check'));
  assert.deepEqual(req.body, {
    domains: [
      { name: 'a', extension: 'co.uk' },
      { name: 'b', extension: 'co.uk' },
      { name: 'c', extension: 'co.uk' },
    ],
    with_price: true,
  });
});

test('check falls back to the product price when the reseller price is empty', async () => {
  const c = client(() => json(200, { code: 0, data: { results: [checkRow('a.co.uk', { price: { product: { currency: 'GBP', price: 7.5 }, reseller: {} } })] } }));
  assert.equal((await c.reg.check(['a.co.uk']))[0].pricePence, 750);
});

test('a non-GBP price is refused', async () => {
  const usd = client(() => json(200, { code: 0, data: { results: [checkRow('a.co.uk', { price: { reseller: { currency: 'USD', price: 8.06 } } })] } }));
  await rejects(usd.reg.check(['a.co.uk']), 'refused', 200);
  const premiumEur = client(() => json(200, { code: 0, data: { results: [checkRow('a.co.uk', { is_premium: true, premium: { currency: 'EUR', price: { create: 50 } } })] } }));
  await rejects(premiumEur.reg.check(['a.co.uk']), 'refused', 200);
});

test('an available name with no usable price is refused', async () => {
  const c = client(() => json(200, { code: 0, data: { results: [checkRow('a.co.uk', { price: {} })] } }));
  await rejects(c.reg.check(['a.co.uk']), 'refused', 200);
});

test('a name that is not a plain label.co.uk is refused before any request', async () => {
  const bad = ['acme.com', 'acme.org.uk', 'www.acme.co.uk', 'a b.co.uk', '.co.uk', 'acme.co.uk/x', '-acme.co.uk', 'acme..co.uk', '', 'acme.co.uk.evil.com'];
  for (const name of bad) {
    const c = client(() => json(200, { code: 0, data: { results: [] } }));
    await rejects(c.reg.check(['fine.co.uk', name]), 'refused', null);
    await rejects(c.reg.findOwned(name), 'refused', null);
    await rejects(c.reg.register(name, { ownerHandle: 'H-1' }), 'refused', null);
    await rejects(c.reg.info(name), 'refused', null);
    assert.equal(c.calls.length, 0, `no request for ${JSON.stringify(name)}`);
  }
});

test('check of no names makes no request', async () => {
  const c = client(() => json(200, {}));
  assert.deepEqual(await c.reg.check([]), []);
  assert.equal(c.calls.length, 0);
});

// ---- register ---------------------------------------------------------------

test('register sends autorenew off, one year and the one handle everywhere; returns ref and expiry', async () => {
  const c = client(() => json(200, { code: 0, data: { id: 987654, status: 'ACT', activation_date: '2026-11-20 10:00:00', expiration_date: '2027-11-20 10:00:00', renewal_date: '2027-11-20 10:00:00' } }));
  const out = await c.reg.register('Acme.co.uk', { ownerHandle: 'XX123456-XX' });
  assert.deepEqual(out, { ref: '987654', expiresAt: '2027-11-20T10:00:00.000Z' });
  const req = c.api()[0];
  assert.equal(req.method, 'POST');
  assert.ok(req.url.endsWith('/domains'));
  const body = req.body as Record<string, unknown>;
  assert.equal(body.autorenew, 'off');
  assert.equal(body.period, 1);
  assert.deepEqual(body.domain, { name: 'acme', extension: 'co.uk' });
  for (const k of ['owner_handle', 'admin_handle', 'tech_handle', 'billing_handle']) assert.equal(body[k], 'XX123456-XX');
});

test('register with no expiry in the reply gives expiresAt null', async () => {
  const c = client(() => json(200, { code: 0, data: { id: 5, status: 'REQ' } }));
  assert.deepEqual(await c.reg.register('acme.co.uk', { ownerHandle: 'H-1' }), { ref: '5', expiresAt: null });
});

test('register: an empty owner handle is refused before any request', async () => {
  const c = client(() => json(200, {}));
  await rejects(c.reg.register('acme.co.uk', { ownerHandle: '  ' }), 'refused', null);
  assert.equal(c.calls.length, 0);
});

test('register: an already-registered response is taken', async () => {
  const conflict = client(() => json(409, { code: 346, desc: 'conflict' }));
  await rejects(conflict.reg.register('acme.co.uk', { ownerHandle: 'H-1' }), 'taken', 409);
  const registered = client(() => json(400, { code: 346, desc: 'Domain is already registered' }));
  await rejects(registered.reg.register('acme.co.uk', { ownerHandle: 'H-1' }), 'taken', 400);
  const notFree = client(() => json(400, { code: 346, desc: 'Domain is not free' }));
  await rejects(notFree.reg.register('acme.co.uk', { ownerHandle: 'H-1' }), 'taken', 400);
  const inBody = client(() => json(200, { code: 346, desc: 'Domain not available' }));
  await rejects(inBody.reg.register('acme.co.uk', { ownerHandle: 'H-1' }), 'taken', 200);
});

test('register: other 4xx is refused, and 5xx / timeout are never taken', async () => {
  await rejects(client(() => json(400, { code: 1, desc: 'Owner handle not found' })).reg.register('acme.co.uk', { ownerHandle: 'H-1' }), 'refused', 400);
  await rejects(client(() => json(403, { code: 1, desc: 'Forbidden' })).reg.register('acme.co.uk', { ownerHandle: 'H-1' }), 'refused', 403);
  await rejects(client(() => json(500, { desc: 'already registered' })).reg.register('acme.co.uk', { ownerHandle: 'H-1' }), 'unclear', 500);
});

test('register: a success reply with no domain id is unclear (it may have happened)', async () => {
  const c = client(() => json(200, { code: 0, data: {} }));
  await rejects(c.reg.register('acme.co.uk', { ownerHandle: 'H-1' }), 'unclear', 200);
});

// ---- findOwned / info -------------------------------------------------------

test('findOwned maps a record and filters by full_name', async () => {
  const c = client(() => json(200, { code: 0, data: { results: [domainRec()], total: 1 } }));
  const out = await c.reg.findOwned('acme.co.uk');
  assert.deepEqual(out, { ref: '4242', expiresAt: '2027-11-20T10:30:00.000Z', autoRenew: false });
  const req = c.api()[0];
  assert.equal(req.method, 'GET');
  assert.ok(req.url.includes('/domains?'));
  assert.ok(req.url.includes('full_name=acme.co.uk'));
});

test('findOwned: empty list, a different name, or a 404 is null, never an error', async () => {
  assert.equal(await client(() => json(200, { code: 0, data: { results: [], total: 0 } })).reg.findOwned('acme.co.uk'), null);
  assert.equal(await client(() => json(200, { code: 0, data: { results: [domainRec({ domain: { name: 'acmeplus', extension: 'co.uk' } })] } })).reg.findOwned('acme.co.uk'), null);
});

test('findOwned: autorenew on is true, default is null, zero dates are null', async () => {
  const on = client(() => json(200, { code: 0, data: { results: [domainRec({ autorenew: 'on' })] } }));
  assert.equal((await on.reg.findOwned('acme.co.uk'))?.autoRenew, true);
  const dflt = client(() => json(200, { code: 0, data: { results: [domainRec({ autorenew: 'default', renewal_date: '0000-00-00 00:00:00', expiration_date: '' })] } }));
  const rec = await dflt.reg.findOwned('acme.co.uk');
  assert.equal(rec?.autoRenew, null);
  assert.equal(rec?.expiresAt, null);
});

test('info reads GET /domains/{id}; missing is null (empty list or 404)', async () => {
  const c = client((call) => (call.url.includes('/domains?') ? json(200, { code: 0, data: { results: [domainRec()] } }) : json(200, { code: 0, data: domainRec({ autorenew: 'on' }) })));
  assert.deepEqual(await c.reg.info('acme.co.uk'), { ref: '4242', expiresAt: '2027-11-20T10:30:00.000Z', autoRenew: true });
  assert.ok(c.api()[1].url.endsWith('/domains/4242'));

  assert.equal(await client(() => json(200, { code: 0, data: { results: [] } })).reg.info('acme.co.uk'), null);
  const gone = client((call) => (call.url.includes('/domains?') ? json(200, { code: 0, data: { results: [domainRec()] } }) : json(404, { code: 399, desc: 'not found' })));
  assert.equal(await gone.reg.info('acme.co.uk'), null);
});

// ---- autorenew / renew ------------------------------------------------------

test('setAutoRenew puts off / on on the domain id', async () => {
  const c = client((call) => (call.method === 'GET' ? json(200, { code: 0, data: { results: [domainRec()] } }) : json(200, { code: 0, data: { id: 4242, status: 'ACT' } })));
  await c.reg.setAutoRenew('acme.co.uk', false);
  await c.reg.setAutoRenew('acme.co.uk', true);
  const puts = c.api().filter((x) => x.method === 'PUT');
  assert.equal(puts.length, 2);
  assert.ok(puts[0].url.endsWith('/domains/4242'));
  assert.deepEqual(puts[0].body, { autorenew: 'off' });
  assert.deepEqual(puts[1].body, { autorenew: 'on' });
});

test('setAutoRenew on a domain we do not own is refused 404 with no write', async () => {
  const c = client(() => json(200, { code: 0, data: { results: [] } }));
  await rejects(c.reg.setAutoRenew('acme.co.uk', true), 'refused', 404);
  assert.equal(c.api().filter((x) => x.method === 'PUT').length, 0);
});

test('renew posts one year and reads the new expiry back', async () => {
  const c = client((call) => {
    if (call.method === 'POST') return json(200, { code: 0, data: { status: 'ACT' } });
    if (call.url.includes('/domains?')) return json(200, { code: 0, data: { results: [domainRec()] } });
    return json(200, { code: 0, data: domainRec({ renewal_date: '2028-11-20 10:30:00' }) });
  });
  assert.deepEqual(await c.reg.renew('acme.co.uk'), { expiresAt: '2028-11-20T10:30:00.000Z' });
  const post = c.api().find((x) => x.method === 'POST');
  assert.ok(post?.url.endsWith('/domains/4242/renew'));
  assert.equal((post?.body as Record<string, unknown>).period, 1);
});

test('renew: a failed renewal is mapped (4xx refused, 5xx unclear), unreadable expiry is unclear', async () => {
  const lookup = json(200, { code: 0, data: { results: [domainRec()] } });
  const refused = client((call) => (call.method === 'POST' ? json(400, { desc: 'cannot renew' }) : lookup.clone()));
  await rejects(refused.reg.renew('acme.co.uk'), 'refused', 400);
  const unclear = client((call) => (call.method === 'POST' ? json(500, {}) : lookup.clone()));
  await rejects(unclear.reg.renew('acme.co.uk'), 'unclear', 500);
  const noExpiry = client((call) => {
    if (call.method === 'POST') return json(200, { code: 0, data: { status: 'ACT' } });
    if (call.url.includes('/domains?')) return lookup.clone();
    return json(200, { code: 0, data: { id: 4242 } });
  });
  await rejects(noExpiry.reg.renew('acme.co.uk'), 'unclear', 200);
});

// ---- DNS --------------------------------------------------------------------

test('setDns replaces the root and www records with fully qualified names', async () => {
  const c = client(() => json(200, { code: 0, data: { success: true } }));
  await c.reg.setDns('acme.co.uk', [
    { type: 'A', host: '@', value: '76.76.21.21' },
    { type: 'CNAME', host: 'www', value: 'cname.vercel-dns.com', ttl: 600 },
  ]);
  const req = c.api()[0];
  assert.equal(req.method, 'PUT');
  assert.ok(req.url.endsWith('/dns/zones/acme.co.uk'));
  assert.deepEqual((req.body as { records: unknown }).records, {
    replace: [
      { name: 'acme.co.uk', type: 'A', value: '76.76.21.21', ttl: 3600 },
      { name: 'www.acme.co.uk', type: 'CNAME', value: 'cname.vercel-dns.com', ttl: 600 },
    ],
  });
});

test('setDns creates the zone when the zone is missing (404)', async () => {
  const c = client((call) => (call.method === 'PUT' ? json(404, { code: 1, desc: 'zone not found' }) : json(200, { code: 0, data: { success: true } })));
  await c.reg.setDns('acme.co.uk', [{ type: 'A', host: '@', value: '76.76.21.21' }]);
  const post = c.api().find((x) => x.method === 'POST');
  assert.ok(post?.url.endsWith('/dns/zones'));
  assert.deepEqual((post?.body as { domain: unknown }).domain, { name: 'acme', extension: 'co.uk' });
});

test('setDns: bad records are refused with no request; success:false and 5xx are mapped', async () => {
  const c = client(() => json(200, { code: 0, data: { success: true } }));
  await rejects(c.reg.setDns('acme.co.uk', [{ type: 'A', host: '@', value: '' }]), 'refused', null);
  await rejects(c.reg.setDns('acme.co.uk', [{ type: 'MX', host: '@', value: 'x' } as never]), 'refused', null);
  assert.equal(c.calls.length, 0);
  await rejects(client(() => json(200, { code: 0, data: { success: false } })).reg.setDns('acme.co.uk', [{ type: 'A', host: '@', value: '1.2.3.4' }]), 'refused', 200);
  await rejects(client(() => json(503, {})).reg.setDns('acme.co.uk', [{ type: 'A', host: '@', value: '1.2.3.4' }]), 'unclear', 503);
});

// ---- IPS tag ----------------------------------------------------------------

test('changeIpsTag is refused (no documented Openprovider call) and sends nothing', async () => {
  const c = client(() => json(200, {}));
  await rejects(c.reg.changeIpsTag('acme.co.uk', 'GODADDY'), 'refused', null);
  assert.equal(c.calls.length, 0);
});

test('transferCode reads auth_code from the domain record and returns it trimmed', async () => {
  const c = client((call) => {
    if (call.method === 'GET' && call.url.includes('full_name=')) return json(200, { code: 0, data: { results: [domainRec()] } });
    if (call.method === 'GET' && call.url.endsWith('/domains/4242')) return json(200, { code: 0, data: domainRec({ auth_code: ' Xy7-secret ' }) });
    return json(404, {});
  });
  assert.equal(await c.reg.transferCode('acme.co.uk'), 'Xy7-secret');
  assert.ok(c.api().every((x) => x.method === 'GET'), 'a read only');
});

test('transferCode: an absent or empty auth_code is refused (the manual step), and so is a name we do not hold', async () => {
  const absent = client((call) => (call.url.includes('full_name=') ? json(200, { code: 0, data: { results: [domainRec()] } }) : json(200, { code: 0, data: domainRec() })));
  await rejects(absent.reg.transferCode('acme.co.uk'), 'refused', null);
  const empty = client((call) => (call.url.includes('full_name=') ? json(200, { code: 0, data: { results: [domainRec()] } }) : json(200, { code: 0, data: domainRec({ auth_code: '  ' }) })));
  await rejects(empty.reg.transferCode('acme.co.uk'), 'refused', null);
  const none = client(() => json(200, { code: 0, data: { results: [] } }));
  await rejects(none.reg.transferCode('acme.co.uk'), 'refused', 404);
});

test('transferCode never puts the code in an error message', async () => {
  const c = client(() => json(500, { code: 1, desc: 'auth_code Xy7-secret' }));
  await assert.rejects(c.reg.transferCode('acme.co.uk'), (e: unknown) => e instanceof RegistrarError && !e.message.includes('Xy7'));
});

test('the registrar id is openprovider', () => {
  assert.equal(createOpenprovider({ username: 'u', password: 'p', sandbox: true, fetch: (async () => json(200, {})) as typeof fetch }).id, 'openprovider');
});

// ---- no leaks ---------------------------------------------------------------

test('the password and token never reach a thrown message or any console output', async () => {
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir'] as const;
  const spies = methods.map((m) => mock.method(console, m, () => {}));
  const leaky = JSON.stringify({ code: 1, desc: `echo ${PASSWORD} ${TOKEN}`, data: { token: TOKEN, password: PASSWORD } });
  const messages: string[] = [];
  const attempt = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      messages.push(String((e as Error).message), String((e as Error).stack ?? ''), JSON.stringify(e));
    }
  };
  for (const status of [400, 401, 403, 404, 409, 500, 503]) {
    const m = mockFetch(() => new Response(leaky, { status }));
    const reg = createOpenprovider({ username: 'user@example.com', password: PASSWORD, sandbox: false, fetch: m.f });
    await attempt(reg.check(['a.co.uk']));
    await attempt(reg.register('a.co.uk', { ownerHandle: 'H-1' }));
    await attempt(reg.findOwned('a.co.uk'));
    await attempt(reg.setDns('a.co.uk', [{ type: 'A', host: '@', value: '1.2.3.4' }]));
  }
  // A failing login whose body echoes the credentials.
  const badLogin = mockFetch(() => new Response(leaky, { status: 401 }), { autoLogin: false });
  await attempt(createOpenprovider({ username: 'user@example.com', password: PASSWORD, sandbox: false, fetch: badLogin.f }).findOwned('a.co.uk'));
  // A throwing fetch whose error message carries the secrets.
  const boom = (async () => {
    throw new Error(`connect failed ${PASSWORD} ${TOKEN}`);
  }) as typeof fetch;
  await attempt(createOpenprovider({ username: 'user@example.com', password: PASSWORD, sandbox: false, fetch: boom }).findOwned('a.co.uk'));

  assert.ok(messages.length > 20);
  for (const m of messages) {
    assert.ok(!m.includes(PASSWORD), 'password leaked');
    assert.ok(!m.includes(TOKEN), 'token leaked');
    assert.ok(!m.includes('user@example.com'), 'username leaked');
    assert.ok(!m.includes('echo'), 'response body leaked');
  }
  for (const m of messages.filter((x) => x.startsWith('registrar:'))) assert.match(m, /^registrar:(taken|unclear|refused|not_configured)(:\d{3})?$/);
  for (const s of spies) assert.equal(s.mock.callCount(), 0, 'console untouched');
  mock.restoreAll();
});

// ---- source pins ------------------------------------------------------------

const SOURCE = readFileSync(new URL('./openprovider.ts', import.meta.url), 'utf8');

test('source pin: no console use at all', () => {
  assert.ok(!SOURCE.includes('console.'));
  assert.ok(!/\bconsole\b/.test(SOURCE));
});

test('source pin: imports stay inside src/lib/domains and never include server-only', () => {
  const specs = [...SOURCE.matchAll(/^\s*import\b[\s\S]*?\bfrom\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.ok(specs.length >= 1);
  for (const s of specs) assert.match(s, /^\.\/[a-z-]+\.ts$/, `import ${s}`);
  assert.ok(!/import\s+['"]server-only['"]/.test(SOURCE));
  assert.ok(!/\brequire\(/.test(SOURCE));
  assert.ok(!/\bimport\(/.test(SOURCE));
});

test('source pin: password and token are never interpolated into a string, apart from the bearer header', () => {
  // Template literals with an interpolation that mentions password or token.
  const templates = [...SOURCE.matchAll(/`[^`]*\$\{[^}]*(?:password|token)[^}]*\}[^`]*`/gi)].map((m) => m[0]);
  assert.deepEqual(templates, []);
  // The one authorization header interpolates only the bearer value.
  const auth = SOURCE.split('\n').filter((l) => /authorization/.test(l) && l.includes('${'));
  assert.equal(auth.length, 1);
  assert.match(auth[0], /`Bearer \$\{bearer\}`/);
  // String concatenation or toString of them.
  assert.ok(!/['"]\s*\+\s*[\w.]*(?:password|token)/i.test(SOURCE));
  assert.ok(!/(?:password|token)[\w.]*\s*\+\s*['"]/i.test(SOURCE));
  assert.ok(!/(?:password|token)\w*\.(?:toString|concat)\(/i.test(SOURCE));
  // The password is read in one place only: the login body.
  const uses = SOURCE.split('\n').filter((l) => /config\.password/.test(l));
  assert.equal(uses.length, 1);
  assert.match(uses[0], /\/auth\/login/);
  // Errors are built from a code and a status only.
  const errors = [...SOURCE.matchAll(/new RegistrarError\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(errors.length > 10);
  for (const e of errors) assert.ok(!/body|desc|password|token|header/i.test(e), `RegistrarError(${e})`);
});
