"use client";

import { useActionState } from "react";
import { setLeadStageAction, type LeadActionState } from "./lead-actions";
import { LEAD_STAGES, STAGE_LABELS, type LeadStage } from "@/lib/leads/stage";

const INITIAL: LeadActionState = {};

/**
 * One tap moves a lead to a stage. The five buttons replace the stage select;
 * the action (setLeadStageAction) does the scope, seat and logging.
 */
export function StageTaps({ leadId, stage }: { leadId: string; stage: LeadStage }) {
  const [state, action, pending] = useActionState(setLeadStageAction, INITIAL);

  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="leadId" value={leadId} />
      <div role="group" aria-label="Lead stage" className="flex flex-wrap gap-1.5">
        {LEAD_STAGES.map((s) => {
          const current = s === stage;
          return (
            <button
              key={s}
              type="submit"
              name="stage"
              value={s}
              disabled={pending}
              aria-pressed={current}
              className={`min-h-9 rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-60 ${
                current
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-background text-foreground hover:bg-muted"
              }`}
            >
              {STAGE_LABELS[s]}
            </button>
          );
        })}
      </div>
      {pending ? <p className="text-xs text-muted-foreground" role="status">Saving…</p> : null}
      {!pending && state.error ? <p className="text-xs text-destructive" role="alert">{state.error}</p> : null}
    </form>
  );
}
