/**
 * Review R4 (R4-31): the credit sweep's dry run (ledger.ts previewDueGrants) as totals for the admin page: how many
 * grants would expire and for how much, how many of those are starter-pack bonuses, and how many pack bonuses would
 * be lifted instead (the member paid again before the expiry). Totals only: no member is named.
 *
 * Pure: no network, no database, no server-only.
 */

export interface PackExpirySummary {
  expire: { grants: number; members: number; pence: number; packBonuses: number; packBonusPence: number };
  lift: { grants: number; members: number; pence: number };
}

export function packExpirySummary(due: { expire: readonly { user: string; scope: string | null; remainingPence: number }[]; lift: readonly { user: string; remainingPence: number }[] }): PackExpirySummary {
  const pence = (rows: readonly { remainingPence: number }[]) => Math.round(rows.reduce((n, r) => n + (Number.isFinite(r.remainingPence) ? r.remainingPence : 0), 0));
  const pack = due.expire.filter((g) => g.scope === 'pack_bonus');
  return {
    expire: { grants: due.expire.length, members: new Set(due.expire.map((g) => g.user)).size, pence: pence(due.expire), packBonuses: pack.length, packBonusPence: pence(pack) },
    lift: { grants: due.lift.length, members: new Set(due.lift.map((g) => g.user)).size, pence: pence(due.lift) },
  };
}
