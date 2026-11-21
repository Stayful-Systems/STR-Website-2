import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Batch 37 (Phase 8): source pins for the operator's "Take my website" screen. Like the neighbouring
 * *-actions.test.ts files these read the source: every action starts from the signed-in owner, the form
 * gives only providerKey and tag, and no id, code or address is shown or logged.
 */
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const actions = code(read('./transfer-actions.ts'));
const page = code(read('./page.tsx'));
const form = code(read('./TransferForm.tsx'));
const home = code(read('../page.tsx'));
const context = code(read('../../setup/website/context.ts'));

/** [name, body] of each exported async function. */
function exportedActions(src: string): [string, string][] {
  const out: [string, string][] = [];
  for (const m of src.matchAll(/export async function (\w+)\(([^)]*)\)[^{]*\{([\s\S]*?)\n\}\n/g)) out.push([m[1], m[3]]);
  return out;
}

test('every exported action starts with await websiteActor() (owner only)', () => {
  assert.match(actions, /^'use server';/m);
  const list = exportedActions(actions);
  assert.deepEqual(
    list.map(([n]) => n),
    ['transferScreenAction', 'checkTransferAction', 'startTransferAction', 'downloadLinkAction', 'resendCodeAction'],
  );
  for (const [name, body] of list) {
    assert.match(body.trim().split('\n')[0], /^const r = await websiteActor\(\);$/, `${name} starts with websiteActor()`);
    assert.match(body.trim().split('\n')[1], /if \(!r\.ok\)/, `${name} refuses when the actor is not ok`);
  }
  // Only async functions and types are exported (a "use server" file).
  assert.deepEqual([...actions.matchAll(/^export (async function|interface|type|const|function) (\w+)/gm)].filter((m) => m[1] === 'const' || m[1] === 'function').length, 0);
});

test('a team member (or anyone without a site) is refused: websiteActor is owner only', () => {
  assert.match(context, /const ownerId = await ownerIdOrNull\(user\);\s*if \(!ownerId\) return \{ ok: false, reason: 'not_owner' \}/);
  assert.match(page, /const r = await websiteActor\(\);\s*if \(!r\.ok\) \{/);
  assert.match(page, /redirect\("\/leads"\)/);
  assert.match(page, /redirect\("\/login\?redirect=\/leads\/website\/transfer"\)/);
  assert.doesNotMatch(page, /searchParams|params\b/, 'no id comes from the address');
  assert.match(page, /export const dynamic = "force-dynamic"/);
  assert.match(page, /index: false/);
});

test('the form is read for providerKey and tag only, and only after the owner is found', () => {
  const reads = [...actions.matchAll(/formData\.get\('([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(reads)].sort(), ['providerKey', 'tag']);
  assert.doesNotMatch(actions, /formData\.get\('(website|site|user|owner|transfer|funnel|id|ref|domain)/i);
  assert.ok(actions.indexOf('websiteActor()') < actions.indexOf('formData.get'), 'the owner is found before the form is read');
  // The owner is the signed-in actor: never an argument or a form field.
  assert.match(actions, /startTransferLive\(r\.actor\.userId, \{ providerKey: formData\.get\('providerKey'\), tag: formData\.get\('tag'\), dryRun: true \}\)/);
  assert.match(actions, /startTransferLive\(r\.actor\.userId, \{ providerKey: formData\.get\('providerKey'\), tag: formData\.get\('tag'\) \}\)/);
  assert.match(actions, /ownTransfer\(r\.actor\.userId\)/);
  assert.match(actions, /\.eq\('owner_id', ownerId\)/);
  // The only actions that take a form take (prev, formData); the rest take nothing.
  for (const [name, body] of exportedActions(actions)) if (!/^(check|start)TransferAction$/.test(name)) assert.doesNotMatch(body, /formData/, name);
  assert.match(actions, /export async function (check|start)TransferAction\(_prev: TransferFormState, formData: FormData\)/);
});

test('Check is a dry run and Confirm is the real start', () => {
  const check = exportedActions(actions).find(([n]) => n === 'checkTransferAction')![1];
  const start = exportedActions(actions).find(([n]) => n === 'startTransferAction')![1];
  assert.match(check, /dryRun: true/);
  assert.doesNotMatch(check, /revalidatePath/);
  assert.doesNotMatch(start, /dryRun/);
  assert.match(start, /revalidatePath\('\/leads\/website\/transfer'\)/);
});

test('the download link is a signed storage link valid ten minutes, for the owner\'s own ready, open transfer', () => {
  const body = exportedActions(actions).find(([n]) => n === 'downloadLinkAction')![1];
  assert.match(actions, /const LINK_SECONDS = 600;/);
  assert.match(body, /storage\.signedUrl\(own\.exportPath, LINK_SECONDS\)/);
  assert.match(body, /own\.cancelledAt \|\| own\.overlapEndedAt/);
  assert.match(body, /own\.exportState !== 'ready'/);
});

test('"Email me the code again" is owner only, code method only, and the code is never shown, stored or logged', () => {
  const body = exportedActions(actions).find(([n]) => n === 'resendCodeAction')![1];
  assert.match(body, /own\.method !== 'code'/);
  assert.match(body, /own\.domainState !== 'requested'/);
  assert.match(body, /transferCode\(own\.domainName\)/);
  assert.match(body, /sendOwner\(to, transferCodeEmail\(/);
  // The code is only ever the argument of the email; the result carries `sent` or an error, nothing else.
  for (const m of body.matchAll(/return (\{[^}]*\});/g)) assert.match(m[1], /^\{ (error: |sent: true)/, 'only an error line or sent: true is returned');
  assert.match(body, /return \{ sent: true \}/);
  assert.doesNotMatch(actions, /console\.(log|info|warn)/);
  assert.doesNotMatch(body, /console\./);
  assert.doesNotMatch(form, /transferCode|\.code\b/);
});

test('the screen asks nothing of the caller about who or which: no website, owner or transfer id in or out', () => {
  assert.doesNotMatch(actions, /websiteId|website_id|funnelId|user_id|siteById|ownSite\b|recordActivity|from\('leads'\)/);
  const view = actions.match(/export interface TransferView \{[\s\S]*?\n\}/)![0];
  assert.doesNotMatch(view, /\b(id|ref|path|exportPath|ownerId|websiteId)\b/i, 'the view holds no id, ref or path');
  assert.doesNotMatch(form, /type="hidden" name="(website|site|user|owner|transfer|funnel|id|ref)\w*"/i);
  // Writes to leads.status / crm_pushed_at are none: this screen writes no table at all.
  assert.doesNotMatch(actions, /\.(insert|update|upsert|delete)\(/);
  assert.doesNotMatch(actions, /crm_pushed_at/);
});

test('the form posts providerKey and tag and nothing else', () => {
  const names = [...form.matchAll(/\bname="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(names)].sort(), ['providerKey', 'tag']);
  assert.match(form, /TRANSFER_PROVIDERS\.map/);
  assert.match(form, /Other: type its tag/);
  assert.match(form, /\(tag \{p\.tag\}\)/);
  assert.match(form, /Email me the code again/);
  assert.match(form, /works for 10 minutes/);
  assert.match(form, /Confirm and take my website/);
});

test('the number of overlap days comes from settings and is never typed in the copy', () => {
  assert.match(actions, /overlapDays: settings\.overlapDays/);
  assert.match(actions, /methodFor\(deps\.now\(\), settings\.codeFrom, hasDomain\)/);
  assert.match(page, /\{screen\.overlapDays\} days/);
  assert.match(form, /\{overlapDays\} days/);
  for (const [name, src] of [['page', page], ['form', form]] as const) assert.doesNotMatch(src, /\b\d+ days\b|\b\d+ (pounds|£)|£\s?\d/, name);
  assert.match(page, /We&rsquo;ll email you a transfer code/);
  assert.match(page, /screen\.method === "code"/);
  assert.match(page, /with or without a plan/);
});

test('no Stayful asset or typed figure on the screen, and the website home links to it', () => {
  for (const [name, src] of [['page', page], ['form', form]] as const) assert.doesNotMatch(src, /<img|logo\.|\/stayful|£/i, name);
  assert.match(home, /<Link href="\/leads\/website\/transfer" className=\{linkBtn\}>Take my website<\/Link>/);
});
