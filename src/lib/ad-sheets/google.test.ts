import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { createGoogleSheets, GoogleSheetsError, serviceAccountEmail, SHEETS_SCOPE, TOKEN_URL } from './google.ts';
import { parseSheetLink } from './sheet-link.ts';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const EMAIL = 'reader@proj.iam.gserviceaccount.com';
const ENV = { GOOGLE_SHEETS_SA_EMAIL: EMAIL, GOOGLE_SHEETS_SA_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n') };
const SHEET = 'A'.repeat(44);

type Call = { url: string; init?: RequestInit };
function fake(apiStatus = 200, apiBody: unknown = {}, calls: Call[] = []): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === TOKEN_URL) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify(apiBody), { status: apiStatus });
  }) as unknown as typeof fetch;
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof GoogleSheetsError);
    assert.equal(e.message, e.code); // nothing but the code
    return e.code;
  }
  return 'none';
}

test('JWT: 3 parts, header and claims, signature verifies with the public key', async () => {
  const calls: Call[] = [];
  const g = createGoogleSheets({ env: ENV, fetch: fake(200, { sheets: [] }, calls), now: () => 1_700_000_000_000 });
  await g.sheetMeta(SHEET);
  const body = new URLSearchParams(String(calls[0].init?.body));
  assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const jwt = body.get('assertion')!;
  const [h, c, s] = jwt.split('.');
  assert.ok(h && c && s);
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.equal(claims.iss, EMAIL);
  assert.equal(claims.scope, SHEETS_SCOPE);
  assert.equal(claims.aud, TOKEN_URL);
  assert.equal(claims.iat, 1_700_000_000);
  assert.equal(claims.exp, 1_700_003_600);
  const v = createVerify('RSA-SHA256');
  v.update(`${h}.${c}`);
  assert.ok(v.verify(publicKey, Buffer.from(s, 'base64url')));
});

test('status codes map to codes only', async () => {
  for (const [status, code] of [[403, 'not_shared'], [404, 'not_found'], [429, 'rate_limited'], [500, 'error']] as const) {
    const g = createGoogleSheets({ env: ENV, fetch: fake(status, { error: { message: 'secret detail' } }) });
    assert.equal(await codeOf(g.sheetMeta(SHEET)), code);
    assert.equal(await codeOf(g.readRange(SHEET, 'Sheet1', 1, 2)), code);
  }
});

test('unconfigured or short key is not_configured and email is null', async () => {
  let called = false;
  const f = (async () => {
    called = true;
    return new Response('{}');
  }) as unknown as typeof fetch;
  for (const env of [{}, { GOOGLE_SHEETS_SA_EMAIL: EMAIL }, { GOOGLE_SHEETS_SA_EMAIL: EMAIL, GOOGLE_SHEETS_SA_PRIVATE_KEY: 'short' }]) {
    const g = createGoogleSheets({ env, fetch: f });
    assert.equal(await codeOf(g.sheetMeta(SHEET)), 'not_configured');
    assert.equal(g.serviceAccountEmail(), null);
    assert.equal(serviceAccountEmail(env), null);
  }
  assert.equal(called, false);
  assert.equal(serviceAccountEmail(ENV), EMAIL);
});

test('token cached within a run, refreshed a minute before expiry', async () => {
  let t = 0;
  const calls: Call[] = [];
  const g = createGoogleSheets({ env: ENV, fetch: fake(200, { sheets: [] }, calls), now: () => t });
  const tokenCalls = () => calls.filter((c) => c.url === TOKEN_URL).length;
  await g.sheetMeta(SHEET);
  await g.sheetMeta(SHEET);
  assert.equal(tokenCalls(), 1);
  t = 3600_000 - 61_000;
  await g.sheetMeta(SHEET);
  assert.equal(tokenCalls(), 1);
  t = 3600_000 - 59_000;
  await g.sheetMeta(SHEET);
  assert.equal(tokenCalls(), 2);
});

test('sheetMeta returns tabs; readRange quotes the tab and returns strings', async () => {
  const calls: Call[] = [];
  const g = createGoogleSheets({
    env: ENV,
    fetch: fake(200, { sheets: [{ properties: { sheetId: 7, title: "Bob's leads" } }], values: [['a', 5, null], []] }, calls),
  });
  assert.deepEqual(await g.sheetMeta(SHEET), [{ gid: 7, title: "Bob's leads" }]);
  const rows = await g.readRange(SHEET, "Bob's leads", 2, 10);
  assert.deepEqual(rows, [['a', '5', ''], []]);
  const url = decodeURIComponent(calls[calls.length - 1].url);
  assert.ok(url.includes("/values/'Bob''s leads'!2:10"));
  assert.equal((calls[calls.length - 1].init?.headers as Record<string, string>).authorization, 'Bearer tok');
});

test('sheet link parsing', () => {
  const id = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
  const base = `https://docs.google.com/spreadsheets/d/${id}`;
  assert.deepEqual(parseSheetLink(`${base}/edit#gid=123`), { spreadsheetId: id, gid: 123 });
  assert.deepEqual(parseSheetLink(`${base}/edit?gid=45#gid=123`), { spreadsheetId: id, gid: 45 });
  assert.deepEqual(parseSheetLink(`${base}/edit?usp=sharing`), { spreadsheetId: id, gid: null });
  assert.deepEqual(parseSheetLink(`${base}/edit?usp=sharing&gid=9`), { spreadsheetId: id, gid: 9 });
  assert.deepEqual(parseSheetLink(`${base}/edit#gid=0&range=A1`), { spreadsheetId: id, gid: 0 });
  assert.deepEqual(parseSheetLink(base), { spreadsheetId: id, gid: null });
  assert.deepEqual(parseSheetLink(`  ${base}/  `), { spreadsheetId: id, gid: null });
  assert.deepEqual(parseSheetLink(`${base}/edit?gid=abc`), { spreadsheetId: id, gid: null });
  for (const bad of [
    '',
    'not a url',
    `http://docs.google.com/spreadsheets/d/${id}/edit`,
    `https://docs.google.com.evil.com/spreadsheets/d/${id}/edit`,
    `https://evil.com/spreadsheets/d/${id}/edit`,
    `https://notdocs.google.com/spreadsheets/d/${id}/edit`,
    `https://user@docs.google.com/spreadsheets/d/${id}/edit`,
    `https://docs.google.com/document/d/${id}/edit`,
    `https://docs.google.com/spreadsheets/u/0/d/${id}/edit`,
    'https://docs.google.com/spreadsheets/d/short/edit',
    `https://docs.google.com/spreadsheets/d/${id}!bad/edit`,
    `https://docs.google.com/spreadsheets/d/${id}/edit/extra/more`,
    'https://docs.google.com/spreadsheets/',
    `https://drive.google.com/spreadsheets/d/${id}/edit`,
  ]) {
    assert.equal(parseSheetLink(bad), null, bad);
  }
});
