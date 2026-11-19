import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { brandCssVars, EMPTY_BRAND, readableOn } from '../../../../lib/funnels/brand.ts';
import { dominantColour, brandColour } from '../../../../lib/websites/colour.ts';
import { checkSite } from '../../../../lib/websites/checks.ts';
import { websiteAccess } from '../../../../lib/websites/policy.ts';
import { SAMPLE_COPY, SAMPLE_SETTINGS, SAMPLE_SITE } from '../../../../lib/websites/sample-site.ts';
import { isEditable, parseAreas, parseStepParam, previewPages, previewSettings, alignCopy, missingForCopy, resumeStep, sanitiseCopy, stepPath, validateAbout, validateAreas, validateCompany, validateContact } from './steps.ts';

/**
 * Batch 31 phase 10: the setup flow. Pure rules are tested directly; the
 * server pieces (they need a signed-in session and a database) are source
 * pins in the repo's style.
 */

const dir = new URL('./', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => /\.(tsx?|ts)$/.test(f) && !f.endsWith('.test.ts'));

const actions = code(read('actions.ts'));
const context = code(read('context.ts'));

// ── Pins ──

test('no conversion event anywhere in the website setup (issue #18)', () => {
  assert.ok(files.length >= 7, `read ${files.join(', ')}`);
  for (const f of files) {
    const s = code(read(f));
    assert.doesNotMatch(s, /logConversion|meta\/conversions/, f);
    assert.doesNotMatch(s, /funnels\/charge-server|funnels\/tiers/, f);
  }
  const golive = code(readFileSync(new URL('../../../../lib/websites/golive-server.ts', import.meta.url), 'utf8'));
  assert.doesNotMatch(golive, /logConversion|meta\/conversions/);
});

test('every step logs funnel_setup_step with its own website_setup_step:N key; go-live logs through golive only', () => {
  assert.match(actions, /'funnel_setup_step', \{ dedupeKey: `website_setup_step:\$\{step\}`/);
  // Steps 1 to 4 save through saveStep (which logs the step); skip on 4 and approve log it directly.
  assert.match(actions, /await stepDone\(actor, step, extras\)/);
  for (const n of [1, 2, 3, 4]) assert.match(actions, new RegExp(`saveStep\\(who\\.actor, ${n},`), `step ${n}`);
  assert.match(actions, /stepDone\(who\.actor, 4, \{ skipped: true \}\)/);
  assert.match(actions, /stepDone\(actor, 5\)/);
  // Approve's own events come from golive-server, with the dedupe keys proven in golive-server.test.ts.
  assert.match(actions, /record: \(kind, opts\) => recordActivity\(actor\.userId, kind, \{ dedupeKey: opts\.dedupeKey/);
});

test('team members are refused: the owner check is ownerIdOrNull, in the one place every action goes through', () => {
  assert.match(context, /ownerIdOrNull\(user\)/);
  assert.match(context, /if \(!ownerId\) return \{ ok: false, reason: 'not_owner' \}/);
  // Every exported action starts from editor() or websiteActor().
  const exported = [...actions.matchAll(/export async function (\w+)\(([^)]*)\)[^{]*\{([\s\S]*?)\n\}\n/g)];
  assert.ok(exported.length >= 9, exported.map((m) => m[1]).join(','));
  for (const [, name, , body] of exported) assert.match(body, /await (editor|websiteActor)\(\)/, name);
  // And the pages redirect a team member away.
  assert.match(context, /redirect\('\/leads'\)/);
});

test('the site is the signed-in owner\'s: no action takes a website, funnel, user or owner id from a form or an argument', () => {
  assert.doesNotMatch(actions, /formData\.get\('(?:id|websiteId|website_id|funnelId|funnel_id|siteId|userId|user_id|ownerId|owner_id|slug|status)'\)/);
  for (const m of actions.matchAll(/export async function \w+\(([^)]*)\)/g)) {
    assert.doesNotMatch(m[1], /\b\w*(?:id|Id|ID)\b|slug|status/, `parameters: ${m[1]}`);
  }
  // The site row and its funnel come from ownSite(ownerId) via the actor.
  assert.match(context, /ownSite\(ownerId\)/);
  assert.match(actions, /funnelId: actor\.site\.funnelId/);
  // The page's [step] param is only ever a step number.
  assert.doesNotMatch(code(read('[step]/page.tsx')), /ownSite|siteById|liveSiteBySlug/);
  assert.match(code(read('[step]/page.tsx')), /parseStepParam\(raw\)/);
  // Writes go through owner-scoped store functions, and the store has no write that takes a site id.
  assert.doesNotMatch(actions, /siteById|from\('websites'\)|createAdminClient/);
});

test('plan gate: go_live while the site is being set up, keep_live once it is live; invited-only', () => {
  assert.match(context, /editable \? 'go_live' : 'keep_live'/);
  assert.match(context, /invited: true/);
  // The behaviour the two purposes give (policy.ts), with the gate ON and an unpaid member.
  const f = { isManagement: true, isOwner: true, invited: true, paid: false };
  assert.deepEqual(websiteAccess(f, true, 'go_live'), { allowed: false, reason: 'plan_required' });
  assert.deepEqual(websiteAccess(f, true, 'keep_live'), { allowed: true });
  assert.deepEqual(websiteAccess({ ...f, invited: false }, false, 'go_live'), { allowed: false, reason: 'not_invited' });
  assert.deepEqual(websiteAccess({ ...f, isOwner: false }, false, 'go_live'), { allowed: false, reason: 'not_owner' });
  assert.equal(isEditable('live'), false);
  assert.equal(isEditable('paused'), false);
  for (const s of ['invited', 'setup', 'preview'] as const) assert.equal(isEditable(s), true);
});

test('generate: first draft vs rewrite is decided on the server from the stored copy; the cap is the copy code\'s', () => {
  assert.match(actions, /kind: site\.pages \? 'regenerate' : 'first'/);
  assert.match(actions, /generateSiteCopy\(\{ websiteId: site\.id/);
  assert.match(actions, /WEBSITE_REGEN_CAP - result\.regenCount/);
  // The action never counts the rewrite itself (generateSiteCopy takes it, and gives it back on a failed draft).
  assert.doesNotMatch(actions, /bumpRegen/);
});

test('approve reads the stored site, runs goLive, and nothing the browser sends reaches it', () => {
  const approve = actions.slice(actions.indexOf('export async function approveAction'));
  assert.match(approve, /export async function approveAction\(\)/);
  assert.match(approve, /await goLive\(\{/);
  assert.match(approve, /rollbackToPreview\(actor\.userId, \{ approvedAt: site\.approvedAt, liveAt: site\.liveAt \}\)/);
  assert.match(approve, /site\.status !== 'preview'/);
});

test('uploads go through the existing uploadLogo path, and "kind" is a closed choice', () => {
  assert.match(actions, /uploadLogo\(\{ userId: actor\.userId, funnelId: actor\.site\.funnelId, bytes \}\)/);
  assert.match(actions, /formData\.get\('kind'\) === 'photo' \? 'photo' : 'logo'/);
  assert.match(actions, /deleteLogoIfOurs\(previous\)/);
});

test('the client reads the logo colour in the browser with colour.ts and keeps a manual override', () => {
  const client = code(read('WebsiteSetup.tsx'));
  assert.match(client, /dominantColour\(ctx\.getImageData/);
  assert.match(client, /createElement\("canvas"\)/);
  assert.match(client, /picked\.current/);
  assert.match(client, /renderSitePage\(pages, path, \{ preview: true \}\)/);
  assert.match(client, /onClickCapture=\{onPreviewClick\}/);
});

// ── Pure rules ──

test('steps: addresses and the resume point', () => {
  assert.equal(stepPath(3), '/leads/setup/website/3');
  assert.equal(parseStepParam('5'), 5);
  for (const bad of ['0', '6', '12', 'x', '', '1 ', '-1', undefined]) assert.equal(parseStepParam(bad as string | undefined), null);

  const empty = { ...SAMPLE_SETTINGS, companyName: '', areas: [], managementFeePct: null, contactEmail: '', contactPhone: '' };
  assert.equal(resumeStep({ settings: empty, hasPages: false, aboutDone: false }), 1);
  assert.equal(resumeStep({ settings: { ...empty, companyName: 'Acme' }, hasPages: false, aboutDone: false }), 2);
  assert.equal(resumeStep({ settings: { ...empty, companyName: 'Acme', areas: ['Leeds'], managementFeePct: 15 }, hasPages: false, aboutDone: false }), 3);
  assert.equal(resumeStep({ settings: SAMPLE_SETTINGS, hasPages: false, aboutDone: false }), 4);
  assert.equal(resumeStep({ settings: SAMPLE_SETTINGS, hasPages: false, aboutDone: true }), 5);
  assert.equal(resumeStep({ settings: SAMPLE_SETTINGS, hasPages: true, aboutDone: false }), 5);
  assert.deepEqual(missingForCopy(SAMPLE_SETTINGS), []);
  assert.deepEqual(missingForCopy(empty).length, 4);
});

test('steps: each step\'s fields are validated', () => {
  assert.deepEqual(validateCompany({ companyName: '  Acme Lets ', brandColour: '#1F5F8B' }), { ok: true, value: { companyName: 'Acme Lets', brandColour: '#1f5f8b' } });
  assert.equal(validateCompany({ companyName: '', brandColour: '' }).ok, false);
  assert.equal(validateCompany({ companyName: 'Acme', brandColour: 'blue' }).ok, false);
  assert.equal(validateCompany({ companyName: 'Acme {{x}}', brandColour: '' }).ok, false);
  assert.deepEqual(parseAreas('Leeds\n leeds, Harrogate ,,\n'), ['Leeds', 'Harrogate']);
  assert.deepEqual(validateAreas({ areas: 'Leeds, York', fee: '15%' }), { ok: true, value: { areas: ['Leeds', 'York'], managementFeePct: 15 } });
  assert.equal(validateAreas({ areas: '', fee: '15' }).ok, false);
  assert.equal(validateAreas({ areas: '!!!', fee: '15' }).ok, false);
  for (const fee of ['', '0', '-3', '101', 'abc']) assert.equal(validateAreas({ areas: 'Leeds', fee }).ok, false, fee);
  assert.equal(validateContact({ email: 'a@acme.co.uk', phone: '0113 496 0123' }).ok, true);
  assert.equal(validateContact({ email: 'nope', phone: '0113 496 0123' }).ok, false);
  assert.equal(validateContact({ email: 'a@acme.co.uk', phone: '12345' }).ok, false);
  assert.deepEqual(validateAbout({ aboutText: '' }), { ok: true, value: { aboutText: null } });
  assert.equal(validateAbout({ aboutText: 'We guarantee your income.' }).ok, false);
});

test('copy the member edits: bounded on the way in, one block per current area', () => {
  const copy = sanitiseCopy(JSON.parse(JSON.stringify(SAMPLE_COPY)));
  assert.deepEqual(copy, SAMPLE_COPY);
  assert.equal(sanitiseCopy({ home: {} }), null);
  assert.equal(sanitiseCopy(null), null);
  const long = sanitiseCopy({ ...SAMPLE_COPY, home: { ...SAMPLE_COPY.home, headline: 'x'.repeat(5000) } });
  assert.equal(long?.home.headline.length, 200);
  // A `{{` is kept as typed: saving never runs the checks, Approve does.
  const kept = sanitiseCopy({ ...SAMPLE_COPY, home: { ...SAMPLE_COPY.home, intro: 'Hello {{name}}' } });
  assert.equal(kept?.home.intro, 'Hello {{name}}');
  const aligned = alignCopy(['Harrogate', 'York'], SAMPLE_COPY);
  assert.deepEqual(aligned.areas.map((a) => a.area), ['Harrogate', 'York']);
  assert.equal(aligned.areas[0].body, SAMPLE_COPY.areas[1].body);
  assert.equal(aligned.areas[1].body, '');
});

test('Approve is blocked by a {{ typed into the copy: the same checkSite the live list and golive use', () => {
  const copy = sanitiseCopy({ ...SAMPLE_COPY, about: { headline: 'About', body: 'We are {{company}}.' } })!;
  const pages = previewPages(SAMPLE_SITE, SAMPLE_SETTINGS, copy)!;
  const r = checkSite(pages, { managementFeePct: SAMPLE_SETTINGS.managementFeePct, brandColour: SAMPLE_SETTINGS.brandColour, logoUrl: SAMPLE_SETTINGS.logoUrl });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.rule === 'placeholder' && p.page === 'about'));
});

// ── The preview's colour wiring (no browser here: the pure part of "override updates the preview") ──

test('a manual colour override changes the preview: page model identity, text colour and the theme variables', () => {
  const before = previewPages(SAMPLE_SITE, SAMPLE_SETTINGS, SAMPLE_COPY)!;
  const after = previewPages(SAMPLE_SITE, SAMPLE_SETTINGS, SAMPLE_COPY, { brandColour: '#B91C1C' })!;
  assert.equal(before[0].site.primary, '#0a96a0');
  assert.equal(after[0].site.primary, '#b91c1c');
  assert.equal(after[0].site.onPrimary, readableOn('#b91c1c'));
  // Every page of the preview carries it, and nothing else about the pages changed.
  assert.ok(after.every((p) => p.site.primary === '#b91c1c'));
  assert.deepEqual(after.map((p) => p.path), before.map((p) => p.path));
  assert.equal(after[0].heading, before[0].heading);
  // SiteShell's siteThemeVars spreads brandCssVars of this primary, and --primary is site.primary.
  assert.deepEqual(brandCssVars({ ...EMPTY_BRAND, primary: after[0].site.primary }), { '--primary': '#b91c1c', '--ring': '#b91c1c', '--primary-foreground': '#ffffff' });
  const shell = readFileSync(new URL('../../../../lib/websites/templates/SiteShell.tsx', import.meta.url), 'utf8');
  assert.match(shell, /const primary = site\.primary \?\? DEFAULT_PRIMARY/);
  assert.match(shell, /'--primary': primary/);
  // An invalid override is ignored, never applied.
  assert.equal(previewSettings(SAMPLE_SETTINGS, { brandColour: 'nonsense' }).brandColour, SAMPLE_SETTINGS.brandColour);
  assert.equal(previewSettings(SAMPLE_SETTINGS, {}).brandColour, SAMPLE_SETTINGS.brandColour);
});

test('the logo colour: a logo\'s dominant colour from pixels, then the same colour path', () => {
  // 4x4 RGBA: mostly brand red on a transparent background.
  const px: number[] = [];
  for (let i = 0; i < 16; i++) px.push(...(i < 12 ? [185, 28, 28, 255] : [0, 0, 0, 0]));
  assert.equal(dominantColour(px, 4, 4), '#b91c1c');
  const c = brandColour('#b91c1c');
  assert.equal(c?.primary, '#b91c1c');
  assert.equal(previewPages(SAMPLE_SITE, SAMPLE_SETTINGS, SAMPLE_COPY, { brandColour: c?.primary })![0].site.primary, '#b91c1c');
});
