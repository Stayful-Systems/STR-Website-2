import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { leadDbMessage, needsAccount, GET_THE_LEAD_DATABASE_URL } from '../../../lib/leaddb/messages.ts';

/**
 * Batch 32 phase 4: the connect screen's server actions and panel, in the
 * repo's source-pin style (they need a session and a database).
 */
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const actions = code(read('./leaddb-actions.ts'));
const panel = read('./LeadDbPanel.tsx');

/** The text of one exported async function. */
function fn(name: string): string {
  const i = actions.indexOf(`export async function ${name}(`);
  assert.ok(i >= 0, `${name} not found`);
  const rest = actions.slice(i + 10);
  const next = rest.search(/\nexport async function /);
  return next < 0 ? rest : rest.slice(0, next);
}

test('every action acts for the owner only: it resolves the owner (null for a team member) before touching a link', () => {
  assert.match(actions, /ownerIdOrNull\(user\)/);
  for (const name of ['sendCodeAction', 'confirmCodeAction', 'testLeadAction']) {
    const body = fn(name);
    assert.match(body, /await gate\(\)/, name);
    assert.ok(body.indexOf('await gate()') < body.indexOf('supabaseLinkDeps()'), `${name}: gate before the link`);
  }
  const disc = fn('disconnectLeadDbAction');
  assert.match(disc, /who === 'member'/);
  assert.ok(disc.indexOf("who === 'member'") < disc.indexOf('revokeLink'));
  assert.match(actions, /Only the account owner can change this\./);
});

test('no action takes an owner id from the form: the owner is always the session\'s', () => {
  assert.doesNotMatch(actions, /formData\.get\('(owner|user|member)/i);
  assert.doesNotMatch(actions, /si_member_id/);
});

test('a confirmed link logs leaddb_connected, once, after the confirm succeeds; no other action logs', () => {
  const confirm = fn('confirmCodeAction');
  assert.match(confirm, /recordActivity\(g\.id, 'leaddb_connected'\)/);
  assert.ok(confirm.indexOf("if (!out.ok) return") < confirm.indexOf('recordActivity'));
  assert.equal((actions.match(/recordActivity\(/g) ?? []).length, 1);
});

test('the connect code is never stored or logged by the action', () => {
  assert.doesNotMatch(actions, /console\./);
  assert.doesNotMatch(actions, /from\('leaddb_links'\)/);
});

test('no_account shows "Get the lead database" with a link, and the leads keep working', () => {
  assert.equal(needsAccount('no_account'), true);
  assert.match(leadDbMessage('no_account'), /could not find a lead database account/);
  assert.match(fn('sendCodeAction'), /noAccount: needsAccount\(out\.code\)/);
  assert.match(panel, /Get the lead database/);
  assert.match(panel, /href=\{GET_THE_LEAD_DATABASE_URL\}/);
  assert.match(panel, /Your leads here keep working either way/);
  assert.match(GET_THE_LEAD_DATABASE_URL, /^https:\/\//);
});

test('the panel: three steps, a test lead, disconnect, and the not-available line', () => {
  for (const s of ['Send code', 'Connect', 'Send a test lead', 'Disconnect', 'Send again']) assert.ok(panel.includes(s), s);
  assert.match(panel, /NOT_AVAILABLE/);
  assert.match(panel, /canEdit/);
  // A team member gets no form.
  assert.match(panel, /Only the account owner can connect it\./);
});

test('the panel is mounted on the integrations page and the delivery step', () => {
  assert.match(read('./page.tsx'), /<LeadDbPanel /);
  assert.match(read('../setup/delivery/page.tsx'), /<LeadDbPanel /);
});

test('the lead list and the lead page show the lead database badge', () => {
  assert.match(read('../LeadList.tsx'), /r\.leadDb/);
  assert.match(read('../page.tsx'), /leadDbBadges\(/);
  assert.match(read('../[id]/page.tsx'), /leadDbBadges\(\[lead\.id\]\)/);
});
