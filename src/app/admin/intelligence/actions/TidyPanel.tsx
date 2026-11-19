'use client';

import { useActionState } from 'react';
import { tidyInstructionsAction, type TidyState } from './actions';

/**
 * Review R4 (R4-31): the nightly tidy's Dry run and Run on /admin/intelligence/actions. Both answer in place
 * (useActionState). Run is offered only after a dry run on this page, and asks first.
 */

const button = 'rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50';

export function TidyPanel() {
  const [state, action, pending] = useActionState<TidyState, FormData>(tidyInstructionsAction, null);
  const dryRunDone = Boolean(state?.ok && state.dry);
  return (
    <div>
      <form action={action} className="flex flex-wrap items-center gap-3">
        <button type="submit" name="apply" value="0" disabled={pending} className={button}>
          {pending ? 'Working…' : 'Dry run'}
        </button>
        <button
          type="submit"
          name="apply"
          value="1"
          disabled={pending || !dryRunDone}
          className={button}
          onClick={(e) => {
            if (!window.confirm('Tidy the unfinished instructions now? Nothing is charged or refunded; the nightly run does the same.')) e.preventDefault();
          }}
        >
          Run
        </button>
        <span className="text-xs text-muted-foreground">{dryRunDone ? 'The counts below are what Run would change.' : 'Dry run first: it counts and changes nothing.'}</span>
      </form>
      {state && !state.ok && <p className="mt-3 text-sm text-destructive">Failed: {state.message}</p>}
      {state?.ok && (
        <p className="mt-3 text-sm text-foreground">
          {state.dry ? 'Would change' : 'Changed'}: {state.cancelled} questions whose answer never came cancelled · {state.expired} countdowns or confirms expired · {state.closed} runs left open closed · {state.snapshots} held listing snapshots cleared.
        </p>
      )}
    </div>
  );
}
