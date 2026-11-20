"use client";

import { useState, useTransition } from "react";
import { dryRunLeadDbRetryAction, leadDbRetryAction, type LeadDbRetryResult } from "./leaddb-admin-actions";

const button = "rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-60";

/** Retry shows what it would do first (a dry run), then resets on a second click. */
export function LeadDbRetry({ leadId }: { leadId: string }) {
  const [preview, setPreview] = useState<LeadDbRetryResult | null>(null);
  const [done, setDone] = useState<LeadDbRetryResult | null>(null);
  const [pending, start] = useTransition();

  if (done) return <span className="text-xs text-muted-foreground" role="status">{done.message}</span>;
  return (
    <div className="space-y-1">
      {preview ? <p className={preview.ok ? "text-xs text-foreground" : "text-xs text-destructive"}>{preview.message}</p> : null}
      {preview?.ok ? (
        <button type="button" disabled={pending} className={button} onClick={() => start(async () => setDone(await leadDbRetryAction(leadId)))}>
          {pending ? "Resetting…" : "Yes, retry"}
        </button>
      ) : (
        <button type="button" disabled={pending} className={button} onClick={() => start(async () => setPreview(await dryRunLeadDbRetryAction(leadId)))}>
          {pending ? "Checking…" : "Retry"}
        </button>
      )}
    </div>
  );
}
