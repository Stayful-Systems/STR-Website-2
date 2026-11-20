import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Batch 36 phase 7: source pins (the server file needs a database and Next).
 */
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const WRITE = /\.(insert|update|upsert|delete)\(/;

test('the leads table is never written: leads.status and leads.crm_pushed_at keep meaning "went to your CRM"', () => {
  for (const file of ['./attribution-server.ts', './attribution.ts']) {
    const src = code(read(file));
    assert.doesNotMatch(src, /crm_pushed_at/);
    // Every .from('<table>') chain: the only one that may write is ad_pack_lead_links.
    const chains = src.split(/\.from\(/).slice(1);
    assert.ok(file === './attribution.ts' || chains.length > 0);
    for (const chain of chains) {
      const table = /^'([a-z_]+)'/.exec(chain)?.[1];
      const upToNextStatement = chain.split(/;\s*\n/)[0];
      if (WRITE.test(upToNextStatement)) assert.equal(table, 'ad_pack_lead_links', `a write on ${table}`);
      if (table === 'leads') assert.doesNotMatch(upToNextStatement, WRITE);
    }
  }
  const server = code(read('./attribution-server.ts'));
  assert.equal((server.match(/\.upsert\(/g) ?? []).length, 1);
  assert.doesNotMatch(server, /\.(insert|update|delete)\(/);
  assert.match(server, /from\('ad_pack_lead_links'\)\.upsert\(/);
});

test('the server file logs no lead details and never imports the generator or store files', () => {
  const src = read('./attribution-server.ts');
  assert.doesNotMatch(code(src), /console\.\w+\([^)]*\b(email|phone|address|name|body)\b/);
  assert.doesNotMatch(src, /store-server|store-types|test-store|generate-/);
});

test('the lead route: one line after the lead database hook, never awaited, one import', () => {
  const src = code(read('../../app/api/s/[slug]/lead/route.ts'));
  const HOOK = /void linkLeadToPackAd\(leadId\)\.catch\(\(\) => \{\}\);/;
  assert.match(src, HOOK);
  assert.equal((src.match(/linkLeadToPackAd\(/g) ?? []).length, 1);
  assert.ok(src.search(HOOK) > src.search(/void enqueueLeadDbPush\(leadId\)/));
  assert.ok(src.search(HOOK) < src.indexOf('await notifyOperatorOfWebsiteLead'));
  assert.doesNotMatch(src, /await linkLeadToPackAd/);
});

test('the lead page: PackAdLine sits beside the lead database badge and is filtered by the scope owner', () => {
  const page = code(read('../../app/leads/[id]/page.tsx'));
  assert.match(page, /<PackAdLine leadId=\{lead\.id\} ownerId=\{scope\.ownerId\} \/>/);
  const line = code(read('../../app/leads/[id]/PackAdLine.tsx'));
  assert.match(line, /packAdLine\(leadId, ownerId\)/);
  const server = code(read('./attribution-server.ts'));
  const fn = server.slice(server.indexOf('export async function packAdLine'));
  assert.match(fn, /from\('ad_pack_lead_links'\)[\s\S]*\.eq\('owner_id', ownerId\)/);
});
