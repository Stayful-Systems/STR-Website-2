"use client";

import { useState, useTransition } from "react";
import type { AdAccountAdminRow } from "@/lib/leaddb/ad-account-admin";
import type { LdAdminResult } from "@/lib/ad-packs/ld-admin-run";
import { grantExtraRoundAction, setAdAccountAllowedAction } from "./leaddb-actions";

const button = "rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-60";
const WHEN = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "2-digit", timeZone: "Europe/London" });
const day = (iso: string | null) => (iso ? WHEN.format(new Date(iso)) : "—");
const yesNo = (v: boolean) => (v ? "Yes" : "No");

/** One owner's row: the account's last state, the Allowed switch and the extra round form (a reason is required). */
function AccountRow({ row }: { row: AdAccountAdminRow }) {
  const [allowed, setAllowed] = useState(row.allowed);
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<LdAdminResult | null>(null);
  const [pending, start] = useTransition();
  const [extra, setExtra] = useState(row.unusedRounds);

  return (
    <tr className="border-t border-border align-top">
      <td className="py-2 pr-3 font-mono">{row.ownerId}</td>
      <td className="pr-3">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={allowed}
            disabled={pending}
            onChange={(e) => {
              const next = e.target.checked;
              start(async () => {
                const r = await setAdAccountAllowedAction(row.ownerId, next);
                setResult(r);
                if (r.ok) setAllowed(next);
              });
            }}
          />
          <span>{allowed ? "Allowed" : "Not allowed"}</span>
        </label>
        <div className="text-muted-foreground">{allowed && row.allowedAt ? `Since ${day(row.allowedAt)}` : row.allowedAt ? `Switched off ${day(row.allowedAt)}` : ""}</div>
      </td>
      <td className="pr-3">{yesNo(row.cardOnFile)}</td>
      <td className="pr-3">{row.accountLabel}</td>
      <td className="pr-3">{day(row.cancelEffectiveAt)}</td>
      <td className="pr-3">{yesNo(row.lapsed)}</td>
      <td className="pr-3">{day(row.stateAsOf)}</td>
      <td className="pr-3">{row.routeOpen ? "Open" : `Closed: ${row.routeReason ?? "stopped"}`}</td>
      <td className="min-w-64">
        <div className="text-muted-foreground">{extra === 0 ? "No extra rounds waiting" : `${extra} extra round${extra === 1 ? "" : "s"} waiting`}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            placeholder="Why (required)"
            aria-label="Why you are giving an extra round"
            className="min-w-40 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
          />
          <button
            type="button"
            disabled={pending || reason.trim() === ""}
            className={button}
            onClick={() =>
              start(async () => {
                const r = await grantExtraRoundAction(row.ownerId, reason);
                setResult(r);
                if (r.ok) {
                  setReason("");
                  setExtra((n) => n + 1);
                }
              })
            }
          >
            Grant an extra round
          </button>
        </div>
        {result ? <p role="status" className={result.ok ? "mt-1 text-foreground" : "mt-1 text-destructive"}>{result.message}</p> : null}
      </td>
    </tr>
  );
}

/**
 * The lead database ad accounts: one row per owner with the last state the lead database sent, Zac's Allowed switch and
 * the "Grant an extra round" action. States and flags only: no email, no name.
 */
export function LeadDbAccounts({ accounts, readError }: { accounts: AdAccountAdminRow[]; readError: boolean }) {
  return (
    <section className="mt-8 rounded-xl border border-border bg-card p-5">
      <h2 className="text-base font-semibold text-foreground">Lead database ad accounts</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Owners who make their ads through their lead database account. An owner can make ads only while Allowed is on, a card is on file and the account is
        running. Each owner gets one round of ads in each round period; an extra round lets them make one more, and it needs a reason.
      </p>
      {readError ? <p className="mt-3 rounded-md bg-destructive/10 p-3 text-sm text-destructive">Could not read the lead database accounts just now.</p> : null}
      {!readError && accounts.length === 0 ? <p className="mt-3 rounded-md bg-muted p-3 text-sm text-muted-foreground">No lead database ad accounts yet.</p> : null}
      {accounts.length > 0 ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-medium">Owner</th>
                <th className="pr-3 font-medium">Allowed</th>
                <th className="pr-3 font-medium">Card on file</th>
                <th className="pr-3 font-medium">Account</th>
                <th className="pr-3 font-medium">Cancels on</th>
                <th className="pr-3 font-medium">Lapsed</th>
                <th className="pr-3 font-medium">Last update</th>
                <th className="pr-3 font-medium">Ads route</th>
                <th className="font-medium">Extra round</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <AccountRow key={a.ownerId} row={a} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
