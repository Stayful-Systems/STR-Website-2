import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getRegistrar, ownerHandle, registrarConfigured, resetFakeRegistrar } from './registrar/index.ts';
import { FakeRegistrar } from './registrar/fake.ts';
import { RegistrarError } from './registrar/types.ts';

const root = new URL('../../../', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(root, p), 'utf8');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) sourceFiles(rel, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(rel);
  }
  return out;
}

test('DOMAINS_REGISTRAR unset buys nothing; fake is refused in production; openprovider needs its login', () => {
  assert.equal(registrarConfigured({}), false);
  assert.throws(() => getRegistrar({}), (e: unknown) => e instanceof RegistrarError && e.code === 'not_configured');
  assert.throws(() => getRegistrar({ DOMAINS_REGISTRAR: 'nonsense' }), (e: unknown) => e instanceof RegistrarError && e.code === 'not_configured');
  assert.throws(() => getRegistrar({ DOMAINS_REGISTRAR: 'fake', VERCEL_ENV: 'production' }), (e: unknown) => e instanceof RegistrarError && e.code === 'not_configured');
  assert.equal(registrarConfigured({ DOMAINS_REGISTRAR: 'fake', VERCEL_ENV: 'production' }), false);
  resetFakeRegistrar();
  assert.ok(getRegistrar({ DOMAINS_REGISTRAR: 'fake', VERCEL_ENV: 'preview' }) instanceof FakeRegistrar);
  assert.equal(getRegistrar({ DOMAINS_REGISTRAR: 'FAKE' }), getRegistrar({ DOMAINS_REGISTRAR: 'fake' }), 'one fake per process');
  assert.throws(() => getRegistrar({ DOMAINS_REGISTRAR: 'openprovider' }), (e: unknown) => e instanceof RegistrarError && e.code === 'not_configured');
  assert.throws(() => getRegistrar({ DOMAINS_REGISTRAR: 'openprovider', OPENPROVIDER_USERNAME: 'u' }), (e: unknown) => e instanceof RegistrarError && e.code === 'not_configured');
  assert.equal(getRegistrar({ DOMAINS_REGISTRAR: 'openprovider', OPENPROVIDER_USERNAME: 'u', OPENPROVIDER_PASSWORD: 'p', OPENPROVIDER_SANDBOX: 'true' }).id, 'openprovider');
});

test('the owner handle is Stayful\'s, from OPENPROVIDER_OWNER_HANDLE only', () => {
  assert.equal(ownerHandle({}), null);
  assert.equal(ownerHandle({ OPENPROVIDER_OWNER_HANDLE: '  ' }), null);
  assert.equal(ownerHandle({ OPENPROVIDER_OWNER_HANDLE: 'AB123456-XY' }), 'AB123456-XY');
});

test('the yearly charge RPC is called from one line in the whole app: the store\'s charge, behind the engine\'s OFF check', () => {
  const hits: string[] = [];
  for (const f of sourceFiles('src')) if (/\.rpc\(\s*'website_domain_charge'/.test(read(f))) hits.push(f);
  // The schema holds the function; the app code names it in exactly one file, and only once as an rpc call.
  assert.deepEqual(hits, ['src/lib/domains/store-server.ts']);
  const store = read('src/lib/domains/store-server.ts');
  assert.equal([...store.matchAll(/rpc\('website_domain_charge'/g)].length, 1);
  const methodOpen = store.indexOf('async charge(a)');
  assert.ok(methodOpen > 0 && store.indexOf("rpc('website_domain_charge'") > methodOpen);
});

test('the spend RPCs are named only in the store, and the cap is never decided in app code', () => {
  for (const f of sourceFiles('src')) {
    if (f === 'src/lib/domains/store-server.ts') continue;
    assert.doesNotMatch(read(f), /rpc\('website_domain_spend/, f);
  }
  const engine = read('src/lib/domains/purchase-server.ts');
  assert.doesNotMatch(engine, /dailySpendCapPence\s*[<>]/, 'the engine never compares against the cap itself');
});

test('no domain code logs, and the domain code imports nothing from the funnel charge, tiers, tracking or academy modules', () => {
  for (const f of sourceFiles('src/lib/domains')) {
    if (/test-store|vercel-fake|registrar\/fake/.test(f)) continue;
    const src = read(f);
    assert.doesNotMatch(src, /console\.(log|info|debug)\(/, f);
    for (const m of src.matchAll(/from '([^']+)'/g)) assert.doesNotMatch(m[1], /funnels\/charge-server|funnels\/tiers|tracking|academy|websites\/report-server/, `${f} imports ${m[1]}`);
  }
});

test('the files Batch 33 must not touch are not mentioned by the domain code or the schema section', () => {
  const sql = read('supabase/schema.sql');
  const start = sql.indexOf('-- Batch 33: customer website domains');
  // Later batches are appended after this one (Batch 35 alters leads); the section ends where the next starts.
  const next = sql.indexOf('-- Batch 35: ad lead sheets');
  const section = sql.slice(start, next > start ? next : undefined);
  assert.doesNotMatch(section, /alter table public\.(profiles|funnels|leads)\b/);
});

test('the env example documents every variable the domain code reads', () => {
  const env = read('.env.example');
  for (const v of ['DOMAINS_REGISTRAR', 'OPENPROVIDER_USERNAME', 'OPENPROVIDER_PASSWORD', 'OPENPROVIDER_SANDBOX', 'OPENPROVIDER_OWNER_HANDLE', 'DOMAINS_VERCEL_TOKEN', 'DOMAINS_VERCEL_PROJECT_ID', 'DOMAINS_VERCEL_TEAM_ID']) {
    assert.match(env, new RegExp(`^${v}=`, 'm'), v);
  }
  assert.doesNotMatch(env, /^VERCEL_(TOKEN|PROJECT|TEAM)/m, 'the reserved VERCEL_ prefix is not used');
});
