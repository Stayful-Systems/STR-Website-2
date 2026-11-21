"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import {
  archiveLeadsAction,
  restoreLeadsAction,
  markLeadOpenedAction,
  type LeadActionState,
} from "../lead-actions";
import { type LeadStage } from "@/lib/leads/stage";
import { StageTaps } from "../StageTaps";

const INITIAL: LeadActionState = {};

/**
 * Records that the customer opened this lead, which resets its retention
 * clock. Done from the browser after the page is on screen, not during the
 * server render, so a prefetch or a crawler-ish request cannot count as the
 * customer looking at it. Once per mount.
 */
export function MarkLeadOpened({ leadId }: { leadId: string }) {
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    void markLeadOpenedAction(leadId);
  }, [leadId]);
  return null;
}

export function LeadDetailActions({
  leadId,
  stage,
  archived,
  hasReport,
  reportUrl,
}: {
  leadId: string;
  stage: LeadStage;
  archived: boolean;
  hasReport: boolean;
  reportUrl: string | null;
}) {
  const [archiveState, archiveAction, archivePending] = useActionState(
    archived ? restoreLeadsAction : archiveLeadsAction,
    INITIAL,
  );
  const [copied, setCopied] = useState(false);

  const button = "rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-60";

  return (
    <div className="flex w-full flex-col gap-2 sm:w-auto sm:items-end">
      <StageTaps leadId={leadId} stage={stage} />

      <div className="flex flex-wrap gap-2 sm:justify-end">
        {hasReport ? (
          <a href={`/leads/${leadId}/pdf`} className={button}>Download PDF</a>
        ) : null}
        {reportUrl ? (
          <button
            type="button"
            className={button}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(reportUrl);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              } catch {
                window.prompt("Copy the homeowner's report link:", reportUrl);
              }
            }}
          >
            {copied ? "Copied" : "Copy homeowner's link"}
          </button>
        ) : null}
        <form
          action={archiveAction}
          onSubmit={(e) => {
            if (!archived && !confirm("Archive this lead? It will be deleted permanently after 7 days unless you restore it.")) {
              e.preventDefault();
            }
          }}
        >
          <input type="hidden" name="leadId" value={leadId} />
          <button type="submit" disabled={archivePending} className={button}>
            {archivePending ? "Working…" : archived ? "Restore" : "Archive"}
          </button>
        </form>
      </div>
      {archiveState.error ? <p className="text-xs text-destructive" role="alert">{archiveState.error}</p> : null}
      {archiveState.notice ? <p className="max-w-72 text-xs text-muted-foreground sm:text-right" role="status">{archiveState.notice}</p> : null}
    </div>
  );
}
