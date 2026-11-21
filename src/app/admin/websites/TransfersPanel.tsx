"use client";

import { useState, useTransition } from "react";
import { dryRunTransferAction, runTransferAction, type TransferActionResult, type TransferKind } from "./transfer-admin-actions";

const button = "rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-60";
const primary = "rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60";
const input = "block w-44 rounded-md border border-border bg-background px-2 py-1.5 text-sm";

/** One transfer, as the page reads it: safe fields only (no zip path, no reference, no lead, no transfer code). */
export interface TransferView {
  id: string;
  email: string | null;
  site: string;
  providerName: string;
  ipsTag: string | null;
  method: "tag" | "code" | "none";
  domainName: string | null;
  exportState: "pending" | "ready" | "failed";
  exportError: string | null;
  domainState: "none" | "pending" | "manual" | "requested" | "moved";
  overlapEndsAt: string | null;
  overlapEndedAt: string | null;
  cancelledAt: string | null;
}

const LABEL: Record<TransferKind, string> = {
  retry_export: "Retry export",
  tag_changed: "Tag changed",
  send_code: "Send code",
  mark_moved: "Mark moved",
  cancel: "Cancel",
  end_overlap: "End overlap now",
  new_setup: "Start a new setup",
};

const day = (v: string | null) => (v ? v.slice(0, 10) : "—");

/** Which actions a transfer offers: only those the engine would allow (the server checks again). */
function offered(t: TransferView): TransferKind[] {
  const open = !t.cancelledAt && !t.overlapEndedAt;
  const out: TransferKind[] = [];
  if (open && t.exportState === "failed") out.push("retry_export");
  if (open && t.method === "tag" && (t.domainState === "manual" || t.domainState === "pending")) out.push("tag_changed");
  if (open && t.method === "code" && t.domainState !== "moved") out.push("send_code");
  if (open && t.method !== "none" && t.domainState !== "none" && t.domainState !== "moved") out.push("mark_moved");
  if (!t.cancelledAt && !t.overlapEndedAt && t.domainState !== "moved") out.push("cancel");
  if (open) out.push("end_overlap");
  if (!t.cancelledAt && t.overlapEndedAt) out.push("new_setup");
  return out;
}

/** The manual step, in plain words, when there is one. */
function manualStep(t: TransferView): string | null {
  if (t.cancelledAt || t.overlapEndedAt || t.domainState !== "manual" || !t.domainName) return null;
  if (t.method === "tag") {
    return `Change the tag of ${t.domainName} to ${t.ipsTag ?? "the new provider’s tag"} in Openprovider, then click Tag changed.`;
  }
  return `We could not read the transfer code for ${t.domainName}. Ask for the code to be typed: get it from Openprovider, type it in the box and click Send code (it is emailed to the owner and not kept).`;
}

function stateOf(t: TransferView): string {
  if (t.cancelledAt) return "Cancelled";
  if (t.overlapEndedAt) return "Overlap ended";
  return "Open";
}

const DOMAIN_WORDS: Record<TransferView["domainState"], string> = {
  none: "No domain",
  pending: "Waiting to ask",
  manual: "Manual step",
  requested: "Asked, waiting",
  moved: "Moved",
};
const FILES_WORDS: Record<TransferView["exportState"], string> = { pending: "Being built", ready: "Ready", failed: "Failed" };

/** Website transfers (Batch 37): operators taking their website with them. Every action is a Dry run first. */
export function TransfersPanel({ transfers, readError }: { transfers: TransferView[]; readError: string | null }) {
  return (
    <section className="mt-6 rounded-xl border border-border bg-card p-5">
      <h2 className="text-base font-semibold text-foreground">Website transfers</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Operators who asked to take their website. The tag or code step is usually done for them; when it needs a person it says so here. Cancel is only possible before the domain has moved. Nothing here shows an address or a transfer code.
      </p>
      {readError ? <p className="mt-3 rounded-md bg-destructive/10 p-3 text-sm text-destructive">Read failed (schema.sql not run?): {readError}</p> : null}
      {transfers.length === 0 && !readError ? <p className="mt-3 rounded-md bg-muted p-3 text-sm text-muted-foreground">No transfers yet.</p> : null}
      {transfers.length > 0 ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 pr-3">Operator</th>
                <th className="py-1 pr-3">Site</th>
                <th className="py-1 pr-3">Provider</th>
                <th className="py-1 pr-3">Tag or method</th>
                <th className="py-1 pr-3">Files</th>
                <th className="py-1 pr-3">Domain</th>
                <th className="py-1 pr-3">Overlap ends</th>
                <th className="py-1 pr-3">Last error</th>
                <th className="py-1">Actions</th>
              </tr>
            </thead>
            <tbody>
              {transfers.map((t) => {
                const step = manualStep(t);
                return (
                  <tr key={t.id} className="border-t border-border align-top">
                    <td className="py-2 pr-3 text-xs">{t.email ?? "—"}<br /><span className="text-muted-foreground">{stateOf(t)}</span></td>
                    <td className="py-2 pr-3 text-xs">{t.site}</td>
                    <td className="py-2 pr-3">{t.providerName}</td>
                    <td className="py-2 pr-3 font-mono text-xs">{t.method === "tag" ? t.ipsTag ?? "tag" : t.method === "code" ? "Transfer code" : "No domain"}</td>
                    <td className="py-2 pr-3">{FILES_WORDS[t.exportState]}</td>
                    <td className="py-2 pr-3 text-xs">{t.domainName ?? "—"}<br /><span className="font-medium text-foreground">{DOMAIN_WORDS[t.domainState]}</span></td>
                    <td className="py-2 pr-3">{day(t.overlapEndsAt)}</td>
                    <td className="py-2 pr-3 font-mono text-xs text-destructive">{t.exportError ?? ""}</td>
                    <td className="py-2">
                      {step ? <p className="mb-2 max-w-xs rounded-md bg-muted p-2 text-xs text-foreground">{step}</p> : null}
                      <div className="space-y-2">
                        {offered(t).map((k) => (
                          <Act key={k} kind={k} id={t.id} />
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function Result({ result }: { result: TransferActionResult }) {
  return (
    <div className="mt-2 space-y-1 text-xs">
      <p className={result.ok ? "text-foreground" : "text-destructive"}>{result.message}</p>
      {result.lines.length ? (
        <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
          {result.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** One button: Dry run, then (only for that same action on that same transfer) Run. Send code also takes the typed code. */
function Act({ kind, id }: { kind: TransferKind; id: string }) {
  const [result, setResult] = useState<TransferActionResult | null>(null);
  const [dryPassed, setDryPassed] = useState(false);
  const [code, setCode] = useState("");
  const [pending, start] = useTransition();
  const typed = kind === "send_code";
  return (
    <div className="inline-block align-top">
      {typed ? (
        <input
          className={`${input} mb-1.5`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="Transfer code"
          value={code}
          disabled={pending}
          onChange={(e) => {
            setCode(e.target.value);
            setDryPassed(false);
          }}
        />
      ) : null}
      <div className="flex gap-1.5">
        <button
          type="button"
          className={button}
          disabled={pending || (typed && code.trim() === "")}
          onClick={() => start(async () => { const r = await dryRunTransferAction(kind, id, typed ? code : undefined); setResult(r); setDryPassed(r.canRun); })}
        >
          Dry run: {LABEL[kind]}
        </button>
        {dryPassed ? (
          <button
            type="button"
            className={primary}
            disabled={pending}
            onClick={() => {
              if (kind === "cancel" && !window.confirm("Cancel this transfer? The owner’s files are deleted and the domain can renew again.")) return;
              start(async () => {
                const r = await runTransferAction(kind, id, typed ? code : undefined);
                setResult(r);
                setDryPassed(false);
                // The code goes nowhere after it has been sent.
                if (typed) setCode("");
              });
            }}
          >
            Run {LABEL[kind]}
          </button>
        ) : null}
      </div>
      {result ? <Result result={result} /> : null}
    </div>
  );
}
