'use client';

import { useActionState } from 'react';
import { packExpiryPreviewAction, type PackExpiryState } from './actions';

/**
 * Review R4 (R4-31): the starter-pack expiry preview on /admin/weekly-active: the nightly credit sweep's dry run, as
 * totals. It answers in place and changes nothing.
 */

const button = 'rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50';
const money = (p: number) => `£${(p / 100).toFixed(2)}`;

export function PackExpiryPreview() {
  const [state, action, pending] = useActionState<PackExpiryState, FormData>(packExpiryPreviewAction, null);
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <form action={action} className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={button}>
          {pending ? 'Checking…' : 'Preview what would expire'}
        </button>
        <span className="text-xs text-muted-foreground">A preview only. The nightly credit sweep (03:00 UTC) expires and lifts.</span>
      </form>
      {state && !state.ok && <p className="mt-4 text-sm text-destructive">Failed: {state.message}</p>}
      {state?.ok && (
        <div className="mt-4 space-y-1 text-sm text-foreground">
          <p>
            Would expire: {state.summary.expire.grants} grant{state.summary.expire.grants === 1 ? '' : 's'} for {state.summary.expire.members} member{state.summary.expire.members === 1 ? '' : 's'}, {money(state.summary.expire.pence)} in all; {state.summary.expire.packBonuses} of them starter-pack bonuses ({money(state.summary.expire.packBonusPence)}).
          </p>
          <p>
            Would lift instead (paid again before the expiry): {state.summary.lift.grants} pack bonus{state.summary.lift.grants === 1 ? '' : 'es'} for {state.summary.lift.members} member{state.summary.lift.members === 1 ? '' : 's'}, {money(state.summary.lift.pence)}.
          </p>
        </div>
      )}
    </div>
  );
}
