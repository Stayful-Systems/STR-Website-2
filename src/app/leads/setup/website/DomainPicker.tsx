"use client";

import { useActionState, useState } from "react";
import { chooseDomainAction, type DomainChoiceState } from "./domain-actions";
import { ErrorLine, primaryBtn } from "../ui";

const INITIAL: DomainChoiceState = {};

/**
 * Batch 33: "Choose your web address". The suggested name first, then up to
 * five alternatives, each marked "first year free". The page hands over names
 * only: no price, no registrar detail. What is posted is the chosen name and
 * nothing else: the site is the signed-in owner's own (domain-actions.ts).
 */
export function DomainPicker({ names, again }: { names: string[]; again: boolean }) {
  const [state, action, pending] = useActionState(chooseDomainAction, INITIAL);
  const [picked, setPicked] = useState(names[0] ?? "");
  if (names.length === 0) return null;
  return (
    <form action={action} className="mt-6 space-y-3 rounded-lg border border-border p-4">
      <h2 className="text-lg font-semibold text-foreground">Choose your web address</h2>
      <p className="text-sm text-muted-foreground">
        {again ? "That address was taken before we could buy it. Pick another one: " : ""}
        Your website gets its own address. We register it and look after it for you, and the first year is free. Once it is bought it can&rsquo;t be changed.
      </p>
      <fieldset className="space-y-2" disabled={pending}>
        <legend className="sr-only">Web address</legend>
        {names.map((n, i) => (
          <label key={n} className="flex cursor-pointer items-center gap-3 rounded-md border border-border px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5">
            <input type="radio" name="name" value={n} checked={picked === n} onChange={() => setPicked(n)} className="h-4 w-4 accent-primary" />
            <span className="flex-1 font-medium text-foreground">{n}</span>
            <span className="text-xs text-muted-foreground">{i === 0 ? "Suggested · " : ""}first year free</span>
          </label>
        ))}
      </fieldset>
      <ErrorLine state={state} />
      <button type="submit" disabled={pending || !picked} className={primaryBtn}>
        {pending ? "Setting it up…" : "Use this address"}
      </button>
    </form>
  );
}
