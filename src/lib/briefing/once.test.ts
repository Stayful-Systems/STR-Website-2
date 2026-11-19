import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STALE_MS, claimDecision, mayRelease, shouldCharge, type ExistingRow } from './once.ts';

/**
 * A small model of the pass against member_briefings and the ledger: the
 * same two rules the store and the runner use, driven through retries,
 * overlapping runs and a crash between the charge and the row update.
 */
function world() {
  const rows = new Map<string, ExistingRow & { id: string }>();
  const ledger: { actionId: string; pence: number }[] = [];
  let ids = 0;
  const spent = (actionId: string) => ledger.filter((l) => l.actionId === actionId).reduce((n, l) => n + l.pence, 0);
  /** One run for one member: claim, write, charge, finish; `crashAfterCharge` dies before the row is finished. */
  function run(user: string, day: string, now: Date, opts: { crashAfterCharge?: boolean } = {}): 'done' | 'busy' | 'crashed' {
    const key = `${user}|${day}`;
    const d = claimDecision(rows.get(key) ?? null, now);
    if (d.kind === 'busy') return 'busy';
    let actionId: string;
    if (d.kind === 'insert') {
      actionId = `act-${++ids}`;
      rows.set(key, { id: key, status: 'generating', createdAt: now.toISOString(), actionId });
    } else {
      actionId = d.actionId!;
      rows.get(key)!.createdAt = now.toISOString();
    }
    if (shouldCharge(spent(actionId))) ledger.push({ actionId, pence: 1.4 });
    if (opts.crashAfterCharge) return 'crashed';
    rows.get(key)!.status = 'ready';
    return 'done';
  }
  return { rows, ledger, run };
}

const t0 = new Date('2026-10-06T06:40:00Z');
const at = (ms: number) => new Date(t0.getTime() + ms);

test('one briefing and one charge per member per UK day across retries', () => {
  const w = world();
  assert.equal(w.run('u', '2026-10-06', t0), 'done');
  assert.equal(w.run('u', '2026-10-06', at(60_000)), 'busy'); // a retry
  assert.equal(w.run('u', '2026-10-06', at(15 * 60_000)), 'busy'); // the 06:55 run
  assert.equal(w.ledger.length, 1);
  assert.equal(w.rows.size, 1);
  // The next day is a new briefing.
  assert.equal(w.run('u', '2026-10-07', at(86_400_000)), 'done');
  assert.equal(w.ledger.length, 2);
});

test('an overlapping run leaves a row another run is still writing', () => {
  const w = world();
  assert.equal(w.run('u', 'd', t0, { crashAfterCharge: true }), 'crashed');
  assert.equal(w.run('u', 'd', at(STALE_MS - 1)), 'busy');
  assert.equal(w.ledger.length, 1);
});

test('a run that died after charging is reclaimed and never charges again', () => {
  const w = world();
  assert.equal(w.run('u', 'd', t0, { crashAfterCharge: true }), 'crashed');
  assert.equal(w.run('u', 'd', at(STALE_MS + 1)), 'done');
  assert.equal(w.ledger.length, 1);
  assert.equal(w.rows.get('u|d')!.status, 'ready');
});

test('shouldCharge: nothing on the ledger yet', () => {
  assert.equal(shouldCharge(0), true);
  assert.equal(shouldCharge(1.4), false);
});

// Review R4 (R4-34): the guard for Review R3's R3-16. A claim goes back only when nothing can be on the ledger under it.
test('R3-16: mayRelease gives the claim back only before any charge, on a fresh claim, outside a dry run', () => {
  assert.equal(mayRelease({ charged: false, reclaimed: false, dry: false }), true);
  assert.equal(mayRelease({ charged: true, reclaimed: false, dry: false }), false, 'after the charge started, the row stays for the reclaim');
  assert.equal(mayRelease({ charged: false, reclaimed: true, dry: false }), false, 'a reclaimed row may already hold a charge');
  assert.equal(mayRelease({ charged: true, reclaimed: true, dry: false }), false);
  assert.equal(mayRelease({ charged: false, reclaimed: false, dry: true }), false, 'a dry run claimed nothing');
});

test('R3-16: the runner marks the charge started before it charges, and releases only through mayRelease', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./runner.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const started = src.indexOf('charged = true;');
  const charge = src.indexOf('await chargeOnce(');
  assert.ok(started > 0 && charge > started, 'charged is set before chargeOnce runs');
  const releases = [...src.matchAll(/await releaseClaim\(/g)].map((m) => m.index!);
  assert.ok(releases.length >= 2);
  for (const at of releases) assert.match(src.slice(Math.max(0, at - 90), at), /if \(mayRelease\(\{ charged, reclaimed: claim\.reclaimed, dry: opts\.dry \}\)\) $/);
  // A reclaimed row starts as charged when the ledger already holds its spend.
  assert.match(src, /let charged = paid > 0;/);
});
