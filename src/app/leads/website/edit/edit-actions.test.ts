import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Batch 36 (Phase 4): pins for the edit screen's writes. Source reads, like the
 * setup's website-setup.test.ts: every action starts from the signed-in owner,
 * nothing is read from the form but the setup's own fields, and the only
 * number that arrives is a version number.
 */
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const actions = code(read('./edit-actions.ts'));
const context = code(read('../../setup/website/context.ts'));
const client = code(read('./EditWebsite.tsx'));
const editPage = code(read('./page.tsx'));
const homePage = code(read('../page.tsx'));
const switchOn = code(read('../SwitchOnButton.tsx'));

/** [name, body] of each exported async function. */
function exportedActions(src: string): [string, string][] {
  const out: [string, string][] = [];
  const re = /export async function (\w+)\(([^)]*)\)[^{]*\{([\s\S]*?)\n\}\n/g;
  for (const m of src.matchAll(re)) out.push([m[1], m[3]]);
  return out;
}

test('every action starts from the signed-in owner: editor() (websiteActor) or websiteActor() itself', () => {
  const list = exportedActions(actions);
  assert.deepEqual(
    list.map(([n]) => n),
    ['saveChangesAction', 'uploadImageAction', 'rewritePendingAction', 'approvePageAction', 'savePagesAction', 'publishAction', 'restoreAction', 'discardAction', 'switchOnAction'],
  );
  for (const [name, body] of list) {
    const first = body.trim().split('\n')[0];
    assert.match(first, /await (editor|websiteActor)\(\)/, `${name} starts with ${first}`);
  }
  assert.match(actions, /const r = await websiteActor\(\);[\s\S]*?const run = await editRunFor\(r\.actor\.userId\)/);
});

test('a team member is refused: the owner check is ownerIdOrNull, and the plan gate is the setup\'s', () => {
  assert.match(context, /const ownerId = await ownerIdOrNull\(user\);\s*if \(!ownerId\) return \{ ok: false, reason: 'not_owner' \}/);
  assert.match(actions, /not_owner: 'Only the account owner can edit the website\.'/);
});

test('no action reads a website, user, funnel or version id from the form: only the setup fields (and the closed kind and the image)', () => {
  const read = [...actions.matchAll(/formData\.get\('(\w+)'\)/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(read)], ['aboutText', 'areas', 'brandColour', 'companyName', 'email', 'fee', 'image', 'kind', 'phone']);
  assert.doesNotMatch(actions, /formData\.get\('(website|site|user|owner|funnel|version|id)\w*'\)/i);
  // The kind of image is a closed choice of two words, never passed on as typed.
  assert.match(actions, /const kind = formData\.get\('kind'\) === 'photo' \? 'photo' : 'logo';/);
  // The only argument that is a number is the version number, coerced to a number and looked up among the owner's own versions.
  assert.match(actions, /export async function restoreAction\(versionNo: number\)/);
  assert.match(actions, /who\.run\.restore\(Number\(versionNo\)\)/);
  // A page key is a string the run parses and refuses; the website itself is never an argument.
  assert.match(actions, /who\.run\.approvePage\(String\(key\)\)/);
});

test('the actions never name a website, funnel, user or owner id, the store, or an activity writer', () => {
  assert.doesNotMatch(actions, /websiteId|funnelId|funnel_id|user_id|siteById|ownSite\b|liveSiteBySlug|createAdminClient|recordActivity|supabase/);
  // switch-on is for the signed-in owner's own site only.
  assert.match(actions, /switchOnSite\(r\.actor\.userId\)/);
});

test('field validation is the setup\'s own validators', () => {
  assert.match(actions, /from '\.\.\/\.\.\/setup\/website\/steps'/);
  for (const v of ['validateCompany', 'validateAreas', 'validateContact', 'validateAbout']) assert.match(actions, new RegExp(`${v}\\(`), v);
});

test('the edit save goes to the draft only: through the run, never a store write', () => {
  const body = exportedActions(actions).find(([n]) => n === 'saveChangesAction')![1];
  assert.match(body, /who\.run\.saveDraftFields\(/);
  assert.doesNotMatch(body, /saveSettings|savePages|setStatus|\.from\(/);
});

test('the pages hold no id and send none: no hidden id fields, and the preview is the same renderer as the public site in preview mode', () => {
  for (const [name, src] of [['EditWebsite', client], ['page', editPage], ['home', homePage], ['SwitchOnButton', switchOn]] as const) {
    assert.doesNotMatch(src, /type="hidden" name="(website|site|user|owner|funnel|version)\w*"/i, name);
  }
  assert.match(client, /renderSitePage\(pages, path, \{ preview: true \}\)/);
  assert.match(client, /sitePagesOf\(/);
  assert.match(client, /restoreAction\(v\.versionNo\)/);
  // The pages find the site from who is signed in.
  for (const [name, src] of [['page', editPage], ['home', homePage]] as const) {
    assert.match(src, /await websiteActor\(\)/, name);
    assert.doesNotMatch(src, /ownSite\(|siteById|liveSiteBySlug|searchParams|params/, name);
  }
});

test('an edit or request on a paused or switched-off site says why, and the switched-off view says what deletion removes (only then)', () => {
  assert.match(editPage, /st\.editable\.message/);
  assert.match(homePage, /DELETION_REMOVES/);
  assert.match(homePage, /DELETION_KEEPS/);
  const removes = homePage.indexOf('DELETION_REMOVES.map');
  const gate = homePage.indexOf('switchedOff && !deleted');
  assert.ok(gate !== -1 && removes > gate, 'the removal list is inside the switched-off branch');
  assert.match(homePage, /<SwitchOnButton \/>/);
});

test('the grace warning on the home page comes from the derived state, not the stored row', () => {
  assert.match(homePage, /graceForSite\(site\.id\)/);
  assert.match(homePage, /grace\?\.pendingSwitchOff/);
  assert.doesNotMatch(homePage, /website_grace|from\("website_grace"\)|\.from\(/);
});
