import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GRACE_KEYS } from '../../../lib/websites/grace-settings.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const actions = read('./console-actions.ts');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const body = code(actions);

/** The exported async functions and their bodies. */
function exported(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  const re = /export async function (\w+)\(/g;
  const starts = [...body.matchAll(re)].map((m) => ({ name: m[1], at: m.index! }));
  starts.forEach((s, i) => out.push({ name: s.name, text: body.slice(s.at, starts[i + 1]?.at ?? body.length) }));
  return out;
}

test('every exported action calls requireAdmin() before it reads anything else', () => {
  const fns = exported();
  assert.deepEqual(fns.map((f) => f.name), ['dryRunConsoleAction', 'runConsoleAction', 'dryRunGraceSettingAction', 'saveGraceSettingAction', 'setRequestStatusAction', 'requestScreenshotAction']);
  for (const f of fns) {
    const i = f.text.indexOf('await requireAdmin()');
    assert.ok(i > 0, `${f.name} must call requireAdmin`);
    // Nothing that reads an argument, a store or an engine comes first.
    const before = f.text.slice(0, i);
    assert.doesNotMatch(before, /liveRequestsEngine|settingKey\(|isConsoleKind|checkGraceSetting|updateBillingSetting|runner\(|String\(/, `${f.name} touches something before requireAdmin`);
  }
});

test('the file is a use-server file that exports only async functions, and requireAdmin is the admin allowlist', () => {
  assert.match(actions, /^'use server';/);
  assert.equal([...body.matchAll(/^export (?!async function|interface|type)/gm)].length, 0, 'only async functions (and types) are exported');
  assert.match(body, /isAdminEmail\(data\.user\.email\)/);
});

test('no action takes a user, owner or funnel id: the owner is read from the site on the server', () => {
  for (const f of exported()) {
    const sig = f.text.slice(0, f.text.indexOf('{'));
    assert.doesNotMatch(sig, /ownerId|userId|funnelId|email/i, f.name);
  }
  assert.match(body, /export async function dryRunConsoleAction\(kind: string, websiteId: string\)/);
  assert.match(body, /export async function runConsoleAction\(kind: string, websiteId: string\)/);
});

test('the action names are a closed set, checked by the planner’s own list', () => {
  assert.match(body, /if \(!isConsoleKind\(kind\)\) return \{ \.\.\.FAIL, message: 'Unknown action\.' \}/);
});

test('the settings key set is closed: a field name from the screen is mapped through GRACE_KEYS, never used as a key', () => {
  assert.match(body, /Object\.prototype\.hasOwnProperty\.call\(GRACE_KEYS, field\)/);
  assert.match(body, /GRACE_KEYS\[field as keyof typeof GRACE_KEYS\]/);
  assert.match(body, /checkGraceSetting\(key, value\)/);
  assert.deepEqual(Object.keys(GRACE_KEYS).sort(), ['abandonDays', 'deleteAfterDays', 'warningDays']);
  // updateBillingSetting is only ever given the checked key, never the raw field.
  assert.equal([...body.matchAll(/updateBillingSetting\(([^)]*)\)/g)].map((m) => m[1]).join('|'), 'checked.key, checked.value');
  assert.doesNotMatch(body, /updateBillingSetting\((field|key|value)/);
});

test('change requests: the id is a uuid and the status a known one before the engine is asked', () => {
  assert.match(body, /!UUID\.test\(id\) \|\| !isRequestStatus\(status\)/);
  assert.match(body, /const UUID = \/\^\[0-9a-f-\]\{36\}\$\/i;/);
});

test('log lines carry the admin id, an action and a short id or code: never an address, a note or a request text', () => {
  const logs = [...body.matchAll(/console\.(log|info|warn|error)\((`[^`]*`)\)/g)].map((m) => m[2]);
  assert.ok(logs.length >= 3);
  for (const l of logs) {
    assert.match(l, /\[admin\] website console: \$\{(adminId|admin\.id)\}/, l);
    assert.doesNotMatch(l, /email|notes|body|message|\.url|member/i, l);
  }
});

test('the console page is admin only (a 404 for anyone else), and the client file imports only types from the server-side module', () => {
  const page = read('./page.tsx');
  assert.match(page, /if \(!isAdminEmail\(user\.email\)\) notFound\(\);/);
  assert.match(page, /redirect\("\/login\?redirect=\/admin\/websites"\)/);
  const client = read('./WebsitesConsole.tsx');
  assert.match(client, /import type \{[^}]*\} from "@\/lib\/websites\/grace-admin"/);
  assert.doesNotMatch(client, /^import \{[^}]*\} from "@\/lib\/websites\/(grace-admin|grace-server|edit-requests-store)"/m);
  // Run is only enabled after a dry run for exactly that site and action; Delete asks again.
  assert.match(client, /disabled=\{pending \|\| dryFor !== `\$\{here\.id\}:\$\{here\.kind\}`\}/);
  assert.match(client, /if \(!open \|\| dryFor !== `\$\{open\.id\}:\$\{open\.kind\}`\) return;/);
  assert.match(client, /window\.confirm\("Delete this website/);
});

test('WebsitesPanel gets one link to the console and nothing else', () => {
  const panel = read('../management/WebsitesPanel.tsx');
  assert.equal([...panel.matchAll(/\/admin\/websites/g)].length, 1);
});
