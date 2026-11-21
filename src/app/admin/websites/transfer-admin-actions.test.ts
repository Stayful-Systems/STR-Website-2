import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cancel, type TransferDeps, type TransferRow } from '../../../lib/websites/transfer-run.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const actions = read('./transfer-admin-actions.ts');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const body = code(actions);

/** The exported async functions and their bodies. */
function exported(): { name: string; text: string }[] {
  const starts = [...body.matchAll(/export async function (\w+)\(/g)].map((m) => ({ name: m[1], at: m.index! }));
  return starts.map((s, i) => ({ name: s.name, text: body.slice(s.at, starts[i + 1]?.at ?? body.length) }));
}

test('every exported action calls requireAdmin() first, before it reads any argument', () => {
  const fns = exported();
  assert.deepEqual(fns.map((f) => f.name), ['dryRunTransferAction', 'runTransferAction']);
  for (const f of fns) {
    const open = f.text.indexOf('{');
    const i = f.text.indexOf('await requireAdmin()');
    assert.ok(i > open, `${f.name} must call requireAdmin`);
    // The first statement of the body (after `try {`) is the admin check; nothing reads an argument before it.
    const first = f.text.slice(open).replace(/^\{\s*try \{\s*/, '');
    assert.ok(first.startsWith('const admin = await requireAdmin();'), `${f.name}: requireAdmin is not the first call`);
    assert.doesNotMatch(f.text.slice(0, i), /String\(|KINDS|UUID|perform\(|Live\(/, `${f.name} touches something before requireAdmin`);
  }
});

test('the file is a use-server file that exports only async functions (and types), and requireAdmin is the admin allowlist', () => {
  assert.match(actions, /^'use server';/);
  assert.equal([...body.matchAll(/^export (?!async function|interface|type)/gm)].length, 0);
  assert.match(body, /isAdminEmail\(data\.user\.email\)/);
});

test('only the transfer id, the action kind and (for send_code) the typed code come from the screen', () => {
  assert.match(body, /export async function dryRunTransferAction\(kind: string, transferId: string, code\?: string\)/);
  assert.match(body, /export async function runTransferAction\(kind: string, transferId: string, code\?: string\)/);
  for (const f of exported()) {
    const sig = f.text.slice(0, f.text.indexOf('{'));
    assert.doesNotMatch(sig, /ownerId|userId|websiteId|funnelId|email|\bby\b/i, f.name);
  }
  // The kind is a closed set and the id a uuid before any engine is called.
  assert.match(body, /if \(!KINDS\.includes\(kind\)\) return \{ \.\.\.FAIL, message: 'Unknown action\.' \}/);
  assert.match(body, /if \(!UUID\.test\(id\)\)/);
  // The code reaches the engine only on the send_code branch.
  const codeUses = [...body.matchAll(/\bcode\b(?!:)/g)].length;
  assert.ok(codeUses > 0);
  assert.equal([...body.matchAll(/sendCodeLive\(/g)].length, 1, 'one call, on the send_code branch');
  assert.match(body, /case 'send_code':[\s\S]*?sendCodeLive\(id, typeof code === 'string' \? code : '', \{ dryRun: dry \}\)/);
});

test('each kind calls its own *Live function once; cancel passes the admin id as `by`; the dry run passes dryRun: true', () => {
  for (const [kind, call] of [
    ['retry_export', 'retryExportLive(id, { dryRun: dry })'],
    ['tag_changed', 'markTagChangedLive(id, { dryRun: dry })'],
    ['mark_moved', 'markMovedLive(id, { dryRun: dry })'],
    ['cancel', 'cancelLive(id, { dryRun: dry, by: adminId })'],
    ['end_overlap', 'endOverlapNowLive(id, { dryRun: dry })'],
    ['new_setup', 'startNewSetupLive(id, { dryRun: dry })'],
  ] as const) {
    assert.ok(body.includes(`case '${kind}':\n      return ${call};`), kind);
  }
  const dryFn = exported().find((f) => f.name === 'dryRunTransferAction')!.text;
  const runFn = exported().find((f) => f.name === 'runTransferAction')!.text;
  assert.match(dryFn, /perform\(admin\.id, kind as TransferKind, id, code, true\)/);
  assert.match(runFn, /perform\(admin\.id, kind as TransferKind, id, code, false\)/);
  // A dry run never writes an audit line, never revalidates and never reaches a write path of its own.
  assert.doesNotMatch(dryFn, /console\.|refresh\(|revalidatePath|createAdminClient|\.from\(|\.update\(|\.insert\(/);
});

test('a dry run is read only: it is never "Run" unless the engine said would_*, and the screen needs a dry run for the same action first', () => {
  assert.match(body, /canRun: dry && outcome\.startsWith\('would_'\)/);
  const panel = read('./TransfersPanel.tsx');
  assert.match(panel, /Dry run: \{LABEL\[kind\]\}/);
  assert.match(panel, /\{dryPassed \? \(/);
  assert.match(panel, /setDryPassed\(r\.canRun\)/);
  // Changing the typed code takes the Run button away until another dry run.
  assert.match(panel, /setCode\(e\.target\.value\);\s*setDryPassed\(false\);/);
});

test('audit: one line per run, `[admin] transfers: <admin> <kind> <id8>: ok|refused <code>`, built from ids and the result code only', () => {
  const logs = [...body.matchAll(/console\.(log|info|warn|error)\((`[^`]*(?:`[^`]*`[^`]*)*`)\)/g)].map((m) => m[2]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0], "`[admin] transfers: ${admin.id} ${kind} ${id.slice(0, 8)}: ${r.ok ? 'ok' : `refused ${safeCode(r.code)}`}`");
  // The typed code, an address and a message are not in it, and the line is not logged anywhere else.
  assert.doesNotMatch(logs[0], /\bcode\b(?!\)|\})|email|message|body|plan|lines/);
  assert.match(body, /const safeCode = \(c: unknown\): string => String\(c \?\? ''\)\.replace\(\/\[\^a-z0-9_\]\/gi, ''\)/);
  // The audit sits after the engine call (so it carries the outcome) and before the result is returned.
  const runFn = exported().find((f) => f.name === 'runTransferAction')!.text;
  assert.ok(runFn.indexOf('perform(') < runFn.indexOf('console.info('));
});

test('the typed transfer code is never returned, shown or logged: it is only handed to sendCodeLive', () => {
  // Results are built from the engine's result only (toResult), never from the argument.
  assert.match(body, /function toResult\(r: StepResult, dry: boolean\)/);
  assert.doesNotMatch(body, /\$\{code\}|\+ code|JSON\.stringify\(code/);
  const panel = read('./TransfersPanel.tsx');
  assert.match(panel, /type="password"/);
  assert.match(panel, /autoComplete="off"/);
  assert.match(panel, /if \(typed\) setCode\(""\);/);
  assert.doesNotMatch(panel, /console\.|localStorage|sessionStorage/);
});

test('no console line anywhere in the file carries a lead, an address or the typed code', () => {
  for (const m of body.matchAll(/console\.\w+\([^)]*\)/g)) assert.doesNotMatch(m[0], /lead|address|email|postcode/i, m[0]);
});

// ── Cancel is refused once the domain has moved (the engine's own rule, reached through cancelLive) ──

function movedRow(over: Partial<TransferRow> = {}): TransferRow {
  return {
    id: '11111111-1111-4111-8111-111111111111', websiteId: 'w', ownerId: 'o', ref: 'r', providerKey: 'other', providerName: 'Other', ipsTag: 'ABC', method: 'tag',
    domainId: 'd', domainName: 'example.co.uk', snapshot: {}, exportState: 'ready', exportPath: 'o/x.zip', exportAttempts: 0, exportError: null,
    exportReadyAt: null, exportEmailedAt: null, domainState: 'moved', tagClaimedAt: null, domainRequestedAt: null, codeSentAt: null, domainMovedAt: null,
    stuckAlertedAt: null, movedEmailedAt: null, overlapEndsAt: null, overlapEndedAt: null, cancelledAt: null, cancelledBy: null, ...over,
  };
}

/** A deps object where only the read works: any write, email or registrar call throws and is counted. */
function readOnlyDeps(row: TransferRow) {
  const calls: string[] = [];
  const deps = new Proxy({} as Record<string, unknown>, {
    get: (_t, name: string) => {
      if (name === 'transfer') return async () => row;
      if (name === 'now') return () => new Date('2027-01-01T00:00:00Z');
      return (...args: unknown[]) => {
        calls.push(name);
        void args;
        throw new Error(`unexpected ${name}`);
      };
    },
  }) as unknown as TransferDeps;
  return { deps, calls };
}

test('cancel after the domain has moved is refused, as a dry run and as a run, and writes nothing', async () => {
  for (const dryRun of [true, false]) {
    const { deps, calls } = readOnlyDeps(movedRow());
    const r = await cancel(deps, '11111111-1111-4111-8111-111111111111', { dryRun, by: 'admin-id' });
    assert.deepEqual([r.ok, r.code, r.dryRun], [false, 'moved', dryRun]);
    assert.deepEqual(calls, []);
  }
});

test('a cancel dry run before the move says what would happen and still writes nothing', async () => {
  const { deps, calls } = readOnlyDeps(movedRow({ domainState: 'requested' }));
  const r = await cancel(deps, '11111111-1111-4111-8111-111111111111', { dryRun: true, by: 'admin-id' });
  assert.deepEqual([r.ok, r.code, r.dryRun], [true, 'would_cancel', true]);
  assert.ok((r.plan ?? []).length > 0);
  assert.deepEqual(calls, []);
});

test('the panel never offers Cancel once the domain has moved, and the manual step says it in plain words', () => {
  const panel = read('./TransfersPanel.tsx');
  assert.match(panel, /if \(!t\.cancelledAt && !t\.overlapEndedAt && t\.domainState !== "moved"\) out\.push\("cancel"\);/);
  assert.match(panel, /Change the tag of \$\{t\.domainName\} to \$\{t\.ipsTag \?\? "the new provider’s tag"\} in Openprovider, then click Tag changed\./);
  assert.match(panel, /Ask for the code to be typed/);
  for (const col of ['Operator', 'Site', 'Provider', 'Tag or method', 'Files', 'Domain', 'Overlap ends', 'Last error']) assert.ok(panel.includes(`>${col}</th>`), col);
});

test('the page reads transfers read only, with safe columns, and the panel is admin only like the rest of the page', () => {
  const page = read('./page.tsx');
  assert.match(page, /if \(!isAdminEmail\(user\.email\)\) notFound\(\);/);
  const loader = page.slice(page.indexOf('async function loadTransfers'), page.indexOf('export default async function'));
  assert.doesNotMatch(loader, /\.(insert|update|upsert|delete|rpc)\(/);
  assert.doesNotMatch(loader, /export_path|snapshot|\bref\b|code_sent_at/);
  assert.match(page, /<TransfersPanel transfers=\{transfers\} readError=\{transfersError\} \/>/);
});
