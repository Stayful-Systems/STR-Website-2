import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CALCULATOR_EDITABLE_FIELDS } from './calculator.ts';
import {
  CALCULATOR_FIELD_REFUSAL,
  CALCULATOR_FLOW_REFUSAL,
  CALCULATOR_SETUP_PANELS,
  PANEL_FIELDS,
  SETUP_PANELS,
  calculatorFieldPatch,
  editableFieldsFor,
  setupPanelVisible,
  settingsPatchFor,
  visibleSetupPanels,
} from './calculator-setup.ts';

/** Batch 55 (Part A), phase A5: brand editing for calculator sites. Pure rules, then source pins for the page and the actions. */
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

// ── The pure rules ──

test('a calculator site exposes exactly the seven brand and contact fields, and nothing else', () => {
  const panels = visibleSetupPanels('calculator');
  assert.deepEqual([...panels], [...CALCULATOR_SETUP_PANELS]);
  const fields = panels.flatMap((p) => PANEL_FIELDS[p]).sort();
  assert.deepEqual(fields, [...CALCULATOR_EDITABLE_FIELDS].sort());
  assert.deepEqual([...editableFieldsFor('calculator')].sort(), [...CALCULATOR_EDITABLE_FIELDS].sort());
  for (const hidden of ['photo_about', 'page_copy', 'edit_requests', 'approval', 'go_live', 'domain', 'transfer', 'grace'] as const) {
    assert.equal(setupPanelVisible('calculator', hidden), false, hidden);
  }
});

test('a normal site still exposes every panel and every field, as before', () => {
  for (const mode of ['site', null, undefined, 'something-else']) {
    assert.deepEqual([...visibleSetupPanels(mode)], [...SETUP_PANELS], String(mode));
    assert.deepEqual([...editableFieldsFor(mode)].sort(), ['aboutText', 'areas', 'brandColour', 'companyName', 'contactEmail', 'contactPhone', 'logoUrl', 'managementFeePct', 'photoUrl']);
  }
  for (const p of SETUP_PANELS) assert.equal(setupPanelVisible('site', p), true, p);
  // The calculator's panels are a subset of the site's, so nothing is new to a normal site.
  for (const p of CALCULATOR_SETUP_PANELS) assert.ok(SETUP_PANELS.includes(p));
});

test('calculatorFieldPatch keeps the seven fields and refuses anything else, whole', () => {
  const ok = calculatorFieldPatch({ companyName: 'Acme', logoUrl: null, brandColour: '#112233', areas: ['Leeds'], managementFeePct: 15, contactEmail: 'a@b.co', contactPhone: '0113 000 0000' });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(Object.keys(ok.patch).sort(), [...CALCULATOR_EDITABLE_FIELDS].sort());

  // A null is a value (a logo taken away); undefined is "not changed".
  const some = calculatorFieldPatch({ companyName: 'Acme', logoUrl: undefined, brandColour: null });
  assert.deepEqual(some, { ok: true, patch: { companyName: 'Acme', brandColour: null } });

  for (const bad of [{ photoUrl: 'https://x/y.png' }, { aboutText: 'hello' }, { companyName: 'Acme', aboutText: 'hello' }, { status: 'live' }, { pages: {} }]) {
    const r = calculatorFieldPatch(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    if (!r.ok) {
      assert.ok(r.refused.length >= 1);
      assert.equal(r.message, CALCULATOR_FIELD_REFUSAL);
    }
  }
  // A refused field left undefined is not a change.
  assert.deepEqual(calculatorFieldPatch({ aboutText: undefined, photoUrl: undefined }), { ok: true, patch: {} });
});

test('settingsPatchFor passes a normal site through untouched and gates a calculator site', () => {
  const change = { photoUrl: 'https://x/y.png', aboutText: 'hi', companyName: 'Acme' };
  assert.deepEqual(settingsPatchFor('site', change), { ok: true, patch: change });
  assert.deepEqual(settingsPatchFor(undefined, change), { ok: true, patch: change });
  assert.deepEqual(settingsPatchFor('calculator', change), { ok: false, message: CALCULATOR_FIELD_REFUSAL });
  assert.deepEqual(settingsPatchFor('calculator', { companyName: 'Acme' }), { ok: true, patch: { companyName: 'Acme' } });
});

test('the refusal messages are plain English', () => {
  for (const m of [CALCULATOR_FIELD_REFUSAL, CALCULATOR_FLOW_REFUSAL]) {
    assert.match(m, /\.$/);
    assert.doesNotMatch(m, /!|\b(?:mode|calculator_site|payload|patch|api|json|hex)\b/i);
  }
});

// ── Source pins: the page and the actions branch on mode ──

const dir = '../../app/leads/setup/website/';
const page = code(read(`${dir}page.tsx`));
const actions = code(read(`${dir}actions.ts`));
const calcActions = code(read(`${dir}calculator-actions.ts`));
const brandServer = code(read('./calculator-brand-server.ts'));
const context = code(read(`${dir}context.ts`));
const ui = code(read(`${dir}CalculatorBrand.tsx`));

test('the setup page branches on calculator mode before the website steps', () => {
  assert.match(page, /calculatorActor\(\)/);
  assert.match(page, /isCalculatorMode\(calc\.actor\.site\.mode\)/);
  assert.match(page, /<CalculatorBrand settings=\{site\.settings\} \/>/);
  assert.ok(page.indexOf('calculatorActor()') < page.indexOf('websiteSetupContext()'));
  // The calculator screen carries none of the website flows.
  const branch = page.slice(page.indexOf('calculatorActor()'), page.indexOf('websiteSetupContext()'));
  assert.doesNotMatch(branch, /DomainSection|Edit your website|approve|redirect\(/i);
  // The normal flow is still there, unchanged.
  assert.match(page, /if \(ctx\.kind !== "ready"\) return <Notice ctx=\{ctx\} \/>/);
  assert.match(page, /redirect\(stepPath\(ctx\.resume\)\)/);
});

test('the calculator screen shows only the seven fields and no website panels', () => {
  for (const name of ['companyName', 'brandColour', 'areas', 'fee', 'email', 'phone']) assert.match(ui, new RegExp(`name="${name}"`), name);
  assert.match(ui, /kind="logo"/);
  assert.doesNotMatch(ui, /kind="photo"|aboutText|photoUrl|approveAction|generateCopyAction|saveCopyAction|DomainSection|DomainPicker|transfer|Approve/i);
  assert.match(ui, /uploadCalculatorLogoAction/);
  assert.match(ui, /saveCalculatorBrandAction/);
});

test('websiteActor refuses a calculator site for every website flow, and calculatorActor is owner-only with no id from outside', () => {
  assert.match(context, /if \(isCalculatorMode\(site\.mode\)\) return \{ ok: false, reason: 'calculator_site' \}/);
  assert.match(context, /export type ActorDenial = 'signed_out' \| AccessDenial \| 'unavailable' \| 'calculator_site'/);
  const calc = context.slice(context.indexOf('export async function calculatorActor'), context.indexOf('async function stepDone'));
  assert.match(calc, /ownerIdOrNull\(user\)/);
  assert.match(calc, /ownSite\(ownerId\)/);
  assert.match(calc, /!isCalculatorMode\(site\.mode\)/);
  assert.doesNotMatch(calc, /formData|searchParams|params/);
});

test('the website actions refuse a calculator site on the server', () => {
  assert.match(actions, /calculator_site: CALCULATOR_FLOW_REFUSAL/);
  // editor() (every step, upload, copy and colour write) and approveAction both check the mode.
  const editor = actions.slice(actions.indexOf('async function editor()'), actions.indexOf('const refresh'));
  assert.match(editor, /isCalculatorMode\(r\.actor\.site\.mode\)\) return \{ ok: false, error: CALCULATOR_FLOW_REFUSAL \}/);
  const approve = actions.slice(actions.indexOf('export async function approveAction'));
  assert.match(approve, /isCalculatorMode\(r\.actor\.site\.mode\)\) return \{ error: CALCULATOR_FLOW_REFUSAL \}/);
  assert.ok(approve.indexOf('isCalculatorMode') < approve.indexOf('goLive({'));
});

test('the calculator actions are owner-only, validate with the setup rules, and save through the mode gate', () => {
  const exported = [...calcActions.matchAll(/export async function (\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(exported, ['saveCalculatorBrandAction', 'uploadCalculatorLogoAction']);
  const bodies = calcActions.split('export async function ').slice(1);
  for (const b of bodies) assert.match(b, /await owner\(\)/);
  assert.match(calcActions, /await calculatorActor\(\)/);
  assert.match(calcActions, /validateCompany\(/);
  assert.match(calcActions, /validateAreas\(/);
  assert.match(calcActions, /validateContact\(/);
  // The gate sits between the validators and the save: both writes go through the shared helper (also used by /leads/ads).
  assert.ok(calcActions.indexOf('validateContact(') < calcActions.indexOf('saveCalculatorPatch(actor,'));
  assert.match(calcActions, /storeCalculatorLogo\(actor, bytes\)/);
  assert.ok(brandServer.indexOf('calculatorSavePlan(actor.site.mode') < brandServer.indexOf('markCalculatorFieldsEdited(actor.userId, plan.edited)'));
  assert.ok(brandServer.indexOf('markCalculatorFieldsEdited(actor.userId, plan.edited)') < brandServer.indexOf('saveSettings(actor.userId, plan.patch)'), 'edited fields are marked before the settings are written');
  // No page copy, approval, address or status write; no id from the form; no lead or personal detail logged.
  assert.doesNotMatch(calcActions, /savePages|setStatus|goLive|generateSiteCopy|rollbackToPreview|saveChecks|chooseName|createAdminClient|from\('websites'\)/);
  assert.doesNotMatch(calcActions, /formData\.get\('(?:id|websiteId|website_id|funnelId|funnel_id|siteId|userId|user_id|ownerId|owner_id|slug|status)'\)/);
  assert.doesNotMatch(calcActions, /console\.|recordActivity/);
  assert.match(brandServer, /uploadLogo\(\{ userId: actor\.userId, funnelId: actor\.site\.funnelId, bytes \}\)/);
  assert.doesNotMatch(brandServer, /console\.|recordActivity|formData/);
  assert.match(calcActions, /formData\.get\('kind'\) === 'photo'/);
});

test('the other website flows refuse a calculator site through websiteActor', () => {
  for (const f of ['../../app/leads/setup/website/domain-actions.ts', '../../app/leads/website/transfer/transfer-actions.ts', '../../app/leads/website/requests/request-actions.ts', '../../app/leads/website/edit/edit-actions.ts']) {
    assert.match(code(read(f)), /await websiteActor\(\)/, f);
  }
  assert.match(code(read('../../app/leads/website/edit/edit-actions.ts')), /calculator_site:/);
});

test('the shared brand save plan: only calculator fields, and only really changed profile fields are marked edited', async () => {
  const { calculatorSavePlan } = await import('./calculator-brand.ts');
  const before = { logoUrl: 'https://ours.test/l.png', brandColour: '#1f4e79', areas: ['Leeds'], managementFeePct: 15 };
  const same = calculatorSavePlan('calculator', before, { companyName: 'Acme Lets', brandColour: '#1F4E79' });
  assert.ok(same.ok);
  if (same.ok) {
    assert.deepEqual(same.patch, { companyName: 'Acme Lets', brandColour: '#1F4E79' });
    assert.deepEqual(same.edited, [], 'the same colour in other letters is not a change; the company name is never pushed');
  }
  const changed = calculatorSavePlan('calculator', before, { companyName: 'Acme Lets', brandColour: '#000000' });
  assert.ok(changed.ok && changed.edited.join() === 'brandColour');
  const logo = calculatorSavePlan('calculator', before, { logoUrl: 'https://ours.test/new.png' });
  assert.ok(logo.ok && logo.edited.join() === 'logoUrl');
  assert.equal(calculatorSavePlan('calculator', before, { aboutText: 'x' } as never).ok, false, 'a calculator refuses any other field');
});
