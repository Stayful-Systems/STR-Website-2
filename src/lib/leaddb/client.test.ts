import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postSigned, leadDbConfig, isRetryableStatus, MIN_SECRET_LENGTH, type LeadDbConfig } from './client.ts';
import { verifySignature } from '../crm/signature.ts';

const SECRET = 'a'.repeat(MIN_SECRET_LENGTH);
const config: LeadDbConfig = { baseUrl: 'https://leads.example.test', secret: SECRET };

function fakeFetch(status: number, json: unknown, seen?: { url?: string; init?: RequestInit }): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (seen) {
      seen.url = url;
      seen.init = init;
    }
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

test('config: unset or short secret, or no URL, is null (never a guess)', () => {
  assert.equal(leadDbConfig({}), null);
  assert.equal(leadDbConfig({ SI_LEAD_PUSH_SECRET: SECRET }), null);
  assert.equal(leadDbConfig({ LEADDB_API_URL: 'https://x.test' }), null);
  assert.equal(leadDbConfig({ SI_LEAD_PUSH_SECRET: 'short', LEADDB_API_URL: 'https://x.test' }), null);
  assert.equal(leadDbConfig({ SI_LEAD_PUSH_SECRET: SECRET, LEADDB_API_URL: 'http://evil.test' }), null);
  assert.deepEqual(leadDbConfig({ SI_LEAD_PUSH_SECRET: SECRET, LEADDB_API_URL: 'https://leads.stayful.co.uk/' }), {
    baseUrl: 'https://leads.stayful.co.uk',
    secret: SECRET,
  });
});

test('unconfigured: a non-throwing, retryable not_configured, and nothing is sent', async () => {
  let called = false;
  const r = await postSigned('/api/internal/si/website-leads', {}, { config: null, fetchImpl: (async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch });
  assert.deepEqual(r, { ok: false, code: 'not_configured', retryable: true, status: 0 });
  assert.equal(called, false);
});

test('the request is signed over `${t}.${body}` and the receiver can verify it', async () => {
  const seen: { url?: string; init?: RequestInit } = {};
  const r = await postSigned('/api/internal/si/link/start', { si_member_id: 'm', email: 'a@b.co' }, { config, nowSeconds: 1_700_000_000, fetchImpl: fakeFetch(200, { ok: true, link_id: 'l' }, seen) });
  assert.equal(r.ok, true);
  assert.equal(seen.url, 'https://leads.example.test/api/internal/si/link/start');
  const headers = seen.init?.headers as Record<string, string>;
  assert.equal(headers['x-stayful-timestamp'], '1700000000');
  const verdict = verifySignature({ secret: SECRET, body: String(seen.init?.body), header: headers['x-stayful-signature'], nowSeconds: 1_700_000_000 });
  assert.deepEqual(verdict, { ok: true });
  assert.equal(verifySignature({ secret: 'b'.repeat(32), body: String(seen.init?.body), header: headers['x-stayful-signature'], nowSeconds: 1_700_000_000 }).ok, false);
});

test('retry rule: 5xx 408 409 429 401 404 retry; 400 403 413 422 do not', () => {
  for (const s of [500, 502, 503, 408, 409, 429, 401, 404]) assert.equal(isRetryableStatus(s), true, String(s));
  for (const s of [400, 403, 413, 422]) assert.equal(isRetryableStatus(s), false, String(s));
});

test('a refusal reads only the other side\'s short code, and maps to the retry rule', async () => {
  const cases: [number, unknown, string, boolean][] = [
    [403, { ok: false, code: 'not_linked' }, 'not_linked', false],
    [409, { ok: false, code: 'in_progress' }, 'in_progress', true],
    [422, { ok: false, code: 'no_account' }, 'no_account', false],
    [401, { ok: false, code: 'bad_signature' }, 'bad_signature', true],
    [404, {}, 'not_available', true],
    [500, 'html', 'http_500', true],
    // A hostile or buggy body cannot smuggle text into a code.
    [422, { ok: false, code: '12 Acacia Road, Leeds LS1 1AA' }, 'http_422', false],
    // A 200 that did not say ok is a refusal, never retried.
    [200, { ok: false, code: 'bad_report' }, 'bad_report', false],
  ];
  for (const [status, json, code, retryable] of cases) {
    const r = await postSigned('/api/internal/si/website-leads', {}, { config, fetchImpl: fakeFetch(status, json) });
    assert.equal(r.ok, false);
    assert.equal(r.code, code, `${status}`);
    assert.equal(r.retryable, retryable, `${status}`);
  }
});

test('a network error and a timeout are retryable, never throw, and log no body', async () => {
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
  try {
    const boom = (async () => { throw new TypeError('connect ECONNREFUSED 12 Acacia Road'); }) as unknown as typeof fetch;
    const r = await postSigned('/api/internal/si/website-leads', { lead: { address: '12 Acacia Road' } }, { config, fetchImpl: boom });
    assert.deepEqual([r.ok, r.code, r.retryable], [false, 'network', true]);

    const slow = ((_u: string, init?: RequestInit) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })) as unknown as typeof fetch;
    const t = await postSigned('/api/internal/si/website-leads', { lead: { address: '12 Acacia Road' } }, { config, fetchImpl: slow, timeoutMs: 10 });
    assert.deepEqual([t.ok, t.code, t.retryable], [false, 'timeout', true]);
  } finally {
    console.error = orig;
  }
  assert.ok(logged.length >= 2);
  assert.ok(!logged.join('\n').includes('Acacia'), 'no address in logs');
});
