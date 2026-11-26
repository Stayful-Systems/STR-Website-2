import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signatureHeader } from '../crm/signature.ts';
import { MAX_INBOUND_BYTES, verifyInbound } from './inbound.ts';

/**
 * Batch 55 Part A, phase A3: the signed door the lead database calls. The
 * scheme is the one client.ts signs outbound with, so the tests sign with the
 * very same `signatureHeader`.
 */
const SECRET = 's'.repeat(40);
const NOW = 1_800_000_000;
const env = { SI_LEAD_PUSH_SECRET: SECRET };

function signed(body: string, over: { secret?: string; ts?: number; header?: string | null } = {}): Request {
  const ts = over.ts ?? NOW;
  const headers: Record<string, string> = { 'content-type': 'application/json', [TIMESTAMP_HEADER]: String(ts) };
  const header = over.header === undefined ? signatureHeader(over.secret ?? SECRET, body, ts) : over.header;
  if (header !== null) headers[SIGNATURE_HEADER] = header;
  return new Request('https://example.test/api/internal/si/ad-route/state', { method: 'POST', headers, body });
}

test('a good signature returns the raw body and the parsed json', async () => {
  const body = JSON.stringify({ ld_customer_id: 'c1' });
  const res = await verifyInbound(signed(body), { env, nowSeconds: NOW });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.raw, body);
    assert.deepEqual(res.json, { ld_customer_id: 'c1' });
  }
});

test('the same client signature as the outbound client verifies (identical header format)', async () => {
  const body = '{"a":1}';
  const header = signatureHeader(SECRET, body, NOW);
  assert.match(header, /^t=\d+,v1=[0-9a-f]{64}$/);
  const res = await verifyInbound(signed(body, { header }), { env, nowSeconds: NOW });
  assert.equal(res.ok, true);
});

test('a wrong signature is 401 with a code only', async () => {
  const res = await verifyInbound(signed('{"a":1}', { secret: 'x'.repeat(40) }), { env, nowSeconds: NOW });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.response.status, 401);
    assert.deepEqual(await res.response.json(), { ok: false, code: 'unauthorized' });
  }
});

test('a tampered body is 401', async () => {
  const header = signatureHeader(SECRET, '{"a":1}', NOW);
  const res = await verifyInbound(signed('{"a":2}', { header }), { env, nowSeconds: NOW });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.response.status, 401);
});

test('a missing signature header is 401', async () => {
  const res = await verifyInbound(signed('{"a":1}', { header: null }), { env, nowSeconds: NOW });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.response.status, 401);
});

test('a header with no timestamp is 401', async () => {
  const res = await verifyInbound(signed('{"a":1}', { header: 'v1=' + 'a'.repeat(64) }), { env, nowSeconds: NOW });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.response.status, 401);
});

test('an old timestamp is 401, and so is one too far ahead', async () => {
  const old = await verifyInbound(signed('{"a":1}', { ts: NOW - 301 }), { env, nowSeconds: NOW });
  assert.equal(old.ok, false);
  if (!old.ok) assert.equal(old.response.status, 401);
  const ahead = await verifyInbound(signed('{"a":1}', { ts: NOW + 301 }), { env, nowSeconds: NOW });
  assert.equal(ahead.ok, false);
  if (!ahead.ok) assert.equal(ahead.response.status, 401);
  const edge = await verifyInbound(signed('{"a":1}', { ts: NOW - 300 }), { env, nowSeconds: NOW });
  assert.equal(edge.ok, true);
});

test('an unset secret is an empty 404, even for a correctly signed body', async () => {
  const res = await verifyInbound(signed('{"a":1}'), { env: {}, nowSeconds: NOW });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.response.status, 404);
    assert.equal(await res.response.text(), '');
  }
});

test('a secret under 32 characters is an empty 404', async () => {
  const short = 's'.repeat(31);
  const res = await verifyInbound(signed('{"a":1}', { secret: short }), { env: { SI_LEAD_PUSH_SECRET: short }, nowSeconds: NOW });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.response.status, 404);
    assert.equal(await res.response.text(), '');
  }
  const exact = 's'.repeat(32);
  const ok = await verifyInbound(signed('{"a":1}', { secret: exact }), { env: { SI_LEAD_PUSH_SECRET: exact }, nowSeconds: NOW });
  assert.equal(ok.ok, true);
});

test('a signed body that is not JSON is 400 bad_request', async () => {
  const res = await verifyInbound(signed('not json'), { env, nowSeconds: NOW });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.response.status, 400);
    assert.deepEqual(await res.response.json(), { ok: false, code: 'bad_request' });
  }
});

test('a body over the limit is 413 and is never verified', async () => {
  const body = JSON.stringify({ pad: 'x'.repeat(MAX_INBOUND_BYTES) });
  const res = await verifyInbound(signed(body), { env, nowSeconds: NOW });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.response.status, 413);
});

test('the source never logs, and reads the body once', () => {
  const src = readFileSync(new URL('./inbound.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(src, /console\./);
  assert.equal((src.match(/\.text\(\)/g) ?? []).length, 1);
  assert.doesNotMatch(src, /\.json\(\)/);
});
