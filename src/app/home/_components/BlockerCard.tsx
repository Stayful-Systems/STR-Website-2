"use client";

import { useState, useTransition } from "react";
import { BLOCKER_CARD_COPY } from "@/lib/home/blocker-card";
import { answerBlockerCardAction, dismissBlockerCardAction } from "../actions";

/**
 * Batch 30: "What's the biggest thing holding you back?" on Home: five taps and "Not now".
 * A tap answers the quiz's own question; the card then says thanks and is gone on the next visit.
 */
export function BlockerCard({ options }: { options: readonly { value: string; label: string }[] }) {
  const [state, setState] = useState<"asking" | "thanks" | "gone">("asking");
  const [pending, start] = useTransition();
  if (state === "gone") return null;
  if (state === "thanks")
    return (
      <section aria-label={BLOCKER_CARD_COPY.title} className="mt-6 rounded-2xl border border-primary/30 bg-primary/5 p-5 text-sm font-medium text-foreground" role="status">
        {BLOCKER_CARD_COPY.thanks}
      </section>
    );
  return (
    <section aria-labelledby="blocker-card" className="mt-6 rounded-2xl border border-primary/30 bg-primary/5 p-5">
      <h2 id="blocker-card" className="text-sm font-semibold text-foreground">
        {BLOCKER_CARD_COPY.title}
      </h2>
      <div className="mt-3 flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await answerBlockerCardAction(o.value);
                if (r.ok) setState("thanks");
              })
            }
            className="min-h-10 rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
          >
            {o.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            await dismissBlockerCardAction();
            setState("gone");
          })
        }
        className="mt-3 text-xs text-muted-foreground hover:underline disabled:opacity-50"
      >
        {BLOCKER_CARD_COPY.notNow}
      </button>
    </section>
  );
}
