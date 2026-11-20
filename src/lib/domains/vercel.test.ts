import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VercelError, createVercel, getVercel, vercelConfigured } from './vercel.ts';

const TOKEN = 'vcl_SECRET_TOKEN_123';

interface Call { method: string; url: string; body: unknown; auth: string | null }

/** A fetch that answers from a script, in order, and records what it was asked. */
function mock(script: Array<{ status: number; json?: unknown } | 'throw' | 'hang'>) {
  const calls: Call[] = [];
  let i = 0;
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ method: String(init?.method), url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: new Headers(init?.headers).get('authorization') });
    const step = script[i++];
    if (step === undefined) throw new Error('unexpected extra call');
    if (step === 'throw') throw new TypeError('network down');
    if (step === 'hang') {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    }
    return new Response(JSON.stringify(step.json ?? {}), { status: step.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const make = (script: Parameters<typeof mock>[0], timeoutMs = 50) => {
  const m = mock(script);
  return { ...m, v: createVercel({ token: TOKEN, projectId: 'prj_1', teamId: 'team_1', fetch: m.fn, timeoutMs }) };
};

test('addDomain posts the name to the project with the team and a bearer token', async () => {
  const { v, calls } = make([{ status: 200, json: { name: 'x.co.uk', verified: false } }]);
  await v.addDomain('x.co.uk');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://api.vercel.com/v10/projects/prj_1/domains?teamId=team_1');
  assert.deepEqual(calls[0].body, { name: 'x.co.uk' });
  assert.equal(calls[0].auth, `Bearer ${TOKEN}`);
});

test('addWwwRedirect adds www.<name> as a 308 redirect to the root', async () => {
  const { v, calls } = make([{ status: 200 }]);
  await v.addWwwRedirect('x.co.uk');
  assert.deepEqual(calls[0].body, { name: 'www.x.co.uk', redirect: 'x.co.uk', redirectStatusCode: 308 });
});

test('"already in this project" counts as OK, whether Vercel says 409 or 400', async () => {
  for (const status of [409, 400]) {
    const { v, calls } = make([{ status, json: { error: { code: 'domain_already_in_use' } } }, { status: 200, json: { name: 'x.co.uk' } }]);
    await v.addDomain('x.co.uk');
    assert.equal(calls[1].method, 'GET');
    assert.match(calls[1].url, /\/v9\/projects\/prj_1\/domains\/x\.co\.uk\?teamId=team_1$/);
  }
});

test('a domain that belongs to ANOTHER project is refused, not treated as ours', async () => {
  const { v } = make([{ status: 409 }, { status: 404 }]);
  await assert.rejects(v.addDomain('x.co.uk'), (e: unknown) => e instanceof VercelError && e.code === 'refused' && e.status === 409);
});

test('other 4xx are refused; a 5xx, a dropped connection and a timeout are unclear', async () => {
  await assert.rejects(make([{ status: 403 }]).v.addDomain('x.co.uk'), (e: unknown) => e instanceof VercelError && e.code === 'refused' && e.status === 403);
  await assert.rejects(make([{ status: 503 }]).v.addDomain('x.co.uk'), (e: unknown) => e instanceof VercelError && e.code === 'unclear' && e.status === 503);
  await assert.rejects(make(['throw']).v.addDomain('x.co.uk'), (e: unknown) => e instanceof VercelError && e.code === 'unclear');
  await assert.rejects(make(['hang']).v.addDomain('x.co.uk'), (e: unknown) => e instanceof VercelError && e.code === 'unclear');
});

test('a name that is not a plain domain is refused before any request', async () => {
  const { v, calls } = make([]);
  for (const bad of ['', 'x co.uk', 'x.co.uk/../y', 'x.co.uk?a=b', 'X.co.uk', '-x.co.uk', 'x.co.uk\n']) await assert.rejects(v.addDomain(bad), (e: unknown) => e instanceof VercelError && e.code === 'refused', JSON.stringify(bad));
  assert.equal(calls.length, 0);
});

test('domainConfig reads the recommended values from Vercel, best rank first', async () => {
  const { v, calls } = make([{ status: 200, json: { misconfigured: true, recommendedIPv4: [{ rank: 2, value: ['9.9.9.9'] }, { rank: 1, value: ['76.76.21.21', '76.76.21.22'] }], recommendedCNAME: [{ rank: 1, value: 'abc123.vercel-dns-017.com' }] } }]);
  const c = await v.domainConfig('x.co.uk');
  assert.equal(calls[0].url, 'https://api.vercel.com/v6/domains/x.co.uk/config?teamId=team_1');
  assert.deepEqual(c, { misconfigured: true, recommendedIPv4: ['76.76.21.21', '76.76.21.22', '9.9.9.9'], recommendedCNAME: 'abc123.vercel-dns-017.com' });
});

test('domainConfig: only an explicit "misconfigured: false" is set up; a missing field is not', async () => {
  assert.equal((await make([{ status: 200, json: { misconfigured: false } }]).v.domainConfig('x.co.uk')).misconfigured, false);
  assert.equal((await make([{ status: 200, json: {} }]).v.domainConfig('x.co.uk')).misconfigured, true);
  const empty = await make([{ status: 200, json: { misconfigured: false } }]).v.domainConfig('x.co.uk');
  assert.deepEqual(empty.recommendedIPv4, []);
  assert.equal(empty.recommendedCNAME, null);
});

test('domainVerified: verified already, verified after asking once, or not', async () => {
  assert.equal(await make([{ status: 200, json: { verified: true } }]).v.domainVerified('x.co.uk'), true);
  const ask = make([{ status: 200, json: { verified: false } }, { status: 200, json: { verified: true } }]);
  assert.equal(await ask.v.domainVerified('x.co.uk'), true);
  assert.equal(ask.calls[1].method, 'POST');
  assert.match(ask.calls[1].url, /\/domains\/x\.co\.uk\/verify\?teamId=team_1$/);
  assert.equal(await make([{ status: 200, json: { verified: false } }, { status: 200, json: { verified: false } }]).v.domainVerified('x.co.uk'), false);
  assert.equal(await make([{ status: 200, json: { verified: false } }, { status: 400 }]).v.domainVerified('x.co.uk'), false);
  assert.equal(await make([{ status: 404 }]).v.domainVerified('x.co.uk'), false);
});

test('removeDomain: done on success, done on a 404, refused on anything else', async () => {
  await make([{ status: 200 }]).v.removeDomain('x.co.uk');
  await make([{ status: 404 }]).v.removeDomain('x.co.uk');
  await assert.rejects(make([{ status: 403 }]).v.removeDomain('x.co.uk'), (e: unknown) => e instanceof VercelError && e.code === 'refused');
  await assert.rejects(make([{ status: 500 }]).v.removeDomain('x.co.uk'), (e: unknown) => e instanceof VercelError && e.code === 'unclear');
  const del = make([{ status: 200 }]);
  await del.v.removeDomain('x.co.uk');
  assert.equal(del.calls[0].method, 'DELETE');
});

test('the token never appears in an error, a message or the console', async () => {
  const seen: string[] = [];
  const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((k) => {
    const orig = console[k];
    console[k] = (...a: unknown[]) => void seen.push(a.map(String).join(' '));
    return () => { console[k] = orig; };
  });
  const errors: unknown[] = [];
  for (const script of [[{ status: 401, json: { error: { message: `bad token ${TOKEN}` } } }], [{ status: 500, json: { token: TOKEN } }], ['throw'], ['hang']] as Parameters<typeof mock>[0][]) {
    try { await make(script).v.addDomain('x.co.uk'); } catch (e) { errors.push(e); }
  }
  spies.forEach((restore) => restore());
  assert.equal(errors.length, 4);
  for (const e of errors) {
    assert.ok(e instanceof VercelError);
    assert.doesNotMatch(String((e as Error).message) + String((e as Error).stack), new RegExp(TOKEN));
    assert.match((e as Error).message, /^vercel:(unclear|refused)(:\d+)?$/);
  }
  assert.deepEqual(seen, [], 'nothing is logged');
});

test('the source never logs and never imports from outside src/lib/domains', () => {
  const src = readFileSync(new URL('./vercel.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /console\./);
  for (const m of src.matchAll(/^import .* from '([^']+)'/gm)) assert.match(m[1], /^\.\//, `import ${m[1]}`);
  assert.doesNotMatch(src, /^import 'server-only'/m);
});

test('getVercel needs all three DOMAINS_VERCEL_* values; the reserved VERCEL_ prefix is not used', () => {
  assert.equal(vercelConfigured({}), false);
  assert.equal(vercelConfigured({ DOMAINS_VERCEL_TOKEN: 't', DOMAINS_VERCEL_PROJECT_ID: 'p' }), false);
  assert.equal(vercelConfigured({ DOMAINS_VERCEL_TOKEN: 't', DOMAINS_VERCEL_PROJECT_ID: 'p', DOMAINS_VERCEL_TEAM_ID: 'x' }), true);
  assert.throws(() => getVercel({ DOMAINS_VERCEL_TOKEN: 't' }), (e: unknown) => e instanceof VercelError && e.code === 'not_configured');
  assert.ok(getVercel({ DOMAINS_VERCEL_TOKEN: 't', DOMAINS_VERCEL_PROJECT_ID: 'p', DOMAINS_VERCEL_TEAM_ID: 'x' }));
  const src = readFileSync(new URL('./vercel.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /process\.env\.VERCEL_/);
});
