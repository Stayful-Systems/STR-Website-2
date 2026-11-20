"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { switchOnAction, type EditState } from "./edit/edit-actions";

const INITIAL: EditState = {};

/**
 * Batch 36: "Switch back on" for a website that was switched off and not yet
 * deleted. The server checks everything (plan when it is required, no unpaid
 * web address charge, the page checks); this only asks and shows the answer.
 */
export function SwitchOnButton() {
  const router = useRouter();
  const [state, action, pending] = useActionState(async () => switchOnAction(), INITIAL);
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, router]);
  return (
    <form action={action} className="space-y-3">
      <button type="submit" disabled={pending} className="min-h-12 w-full rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">
        {pending ? "Switching on…" : "Switch back on"}
      </button>
      {state.error ? (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <p>{state.error}</p>
          {state.problems?.map((p) => <p key={p} className="mt-1">{p}</p>)}
        </div>
      ) : null}
      {state.ok ? <p role="status" className="text-sm text-foreground">{state.message}</p> : null}
    </form>
  );
}
