"use client";

import { useState, useTransition } from "react";
import type { AdminPackRow, AdminView } from "@/lib/ad-packs/admin-view";
import type { LinkMissingAdminResult, RegenerateResult } from "@/lib/ad-packs/admin-run";
import type { AdAccountAdminRow } from "@/lib/leaddb/ad-account-admin";
import { LeadDbAccounts } from "./LeadDbAccounts";
import { dryRunLinkMissingAction, dryRunRegenerateAction, runLinkMissingAction, runRegenerateAction } from "./actions";

const button = "rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-60";
const WHEN = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "2-digit", timeZone: "Europe/London" });
const day = (iso: string | null) => (iso ? WHEN.format(new Date(iso)) : "—");

function Lines({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
      {lines.map((l, i) => (
        <li key={i} className="whitespace-pre-wrap">{l}</li>
      ))}
    </ul>
  );
}

/**
 * Regenerate for one pack. Run is offered only after a Dry run of THIS pack in
 * this session, and it sends the dry run's token back; the server re-plans from
 * the website as it is now and refuses if anything moved.
 */
function Regenerate({ row }: { row: AdminPackRow }) {
  const [dry, setDry] = useState<RegenerateResult | null>(null);
  const [done, setDone] = useState<RegenerateResult | null>(null);
  const [pending, start] = useTransition();

  if (!row.canRegenerate) return <span className="text-xs text-muted-foreground">No area saved yet</span>;
  const shown = done ?? dry;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1.5">
        <button type="button" disabled={pending} className={button} onClick={() => start(async () => { setDone(null); setDry(await dryRunRegenerateAction(row.packId)); })}>
          {pending && !dry ? "Checking…" : "Dry run"}
        </button>
        <button
          type="button"
          disabled={pending || !dry?.canRun || !dry.token || done !== null}
          className={button}
          onClick={() => start(async () => {
            const token = dry?.token;
            if (!token) return;
            setDone(await runRegenerateAction(row.packId, token));
            setDry(null);
          })}
        >
          {pending && dry ? "Making…" : "Run"}
        </button>
      </div>
      {shown ? (
        <div role="status">
          <p className={shown.ok ? "text-xs text-foreground" : "text-xs text-destructive"}>{shown.message}</p>
          <Lines lines={shown.lines} />
        </div>
      ) : null}
    </div>
  );
}

function LinkMissing({ owners }: { owners: { id: string; label: string }[] }) {
  const [owner, setOwner] = useState("");
  const [dry, setDry] = useState<{ owner: string; result: LinkMissingAdminResult } | null>(null);
  const [done, setDone] = useState<LinkMissingAdminResult | null>(null);
  const [pending, start] = useTransition();
  const canRun = dry !== null && dry.owner === owner && dry.result.canRun && done === null;
  const shown = done ?? dry?.result ?? null;

  return (
    <section className="mt-8 rounded-xl border border-border bg-card p-5">
      <h2 className="text-base font-semibold text-foreground">Link missing leads</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Website leads of operators with an approved pack, since it was approved, that have no ad recorded yet (a lead that arrived while a link failed). Safe to repeat: a linked lead is not looked at again.
        The dry run only counts.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="text-xs text-muted-foreground" htmlFor="adpack-owner">Operator</label>
        <select id="adpack-owner" value={owner} onChange={(e) => { setOwner(e.target.value); setDry(null); setDone(null); }} className="rounded-md border border-border bg-background px-2 py-1 text-xs">
          <option value="">All operators</option>
          {owners.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
        <button type="button" disabled={pending} className={button} onClick={() => start(async () => { setDone(null); setDry({ owner, result: await dryRunLinkMissingAction(owner || undefined) }); })}>
          {pending && !dry ? "Counting…" : "Dry run"}
        </button>
        <button type="button" disabled={pending || !canRun} className={button} onClick={() => start(async () => { setDone(await runLinkMissingAction(owner || undefined)); setDry(null); })}>
          {pending && dry ? "Linking…" : "Run"}
        </button>
      </div>
      {shown ? <p role="status" className={shown.ok ? "mt-2 text-xs text-foreground" : "mt-2 text-xs text-destructive"}>{shown.message}</p> : null}
    </section>
  );
}

export function AdPacksPanel({ view, accounts, accountsError }: { view: AdminView; accounts: AdAccountAdminRow[]; accountsError: boolean }) {
  const { rows, totals } = view;
  const owners = rows.map((r) => ({ id: r.ownerId, label: r.company || r.email || r.ownerId.slice(0, 8) }));
  return (
    <>
      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["Packs", String(totals.packs)],
          ["Leads linked to an ad", String(totals.taggedLeads)],
          ["Leads with no ad", String(totals.untagged)],
          ["Spent so far", `£${(totals.costPence / 100).toFixed(2)}`],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-1 text-2xl font-semibold text-foreground">{value}</p>
          </div>
        ))}
      </section>

      <section className="mt-6 overflow-x-auto">
        {rows.length === 0 ? (
          <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">No packs yet.</p>
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-medium">Operator</th>
                <th className="pr-3 font-medium">Status</th>
                <th className="pr-3 font-medium">Version</th>
                <th className="pr-3 font-medium">Generated</th>
                <th className="pr-3 font-medium">Approved</th>
                <th className="pr-3 font-medium">Regens</th>
                <th className="pr-3 font-medium">Cost</th>
                <th className="pr-3 font-medium">Video</th>
                <th className="pr-3 font-medium">Leads per ad</th>
                <th className="pr-3 font-medium">No ad</th>
                <th className="font-medium">Regenerate</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.packId} className="border-t border-border align-top">
                  <td className="py-2 pr-3">
                    <div className="font-medium text-foreground">{r.company ?? "No company name"}</div>
                    <div className="text-muted-foreground">{r.email ?? r.ownerId.slice(0, 8)}</div>
                  </td>
                  <td className="pr-3">{r.statusLabel}</td>
                  <td className="pr-3">{r.version}</td>
                  <td className="pr-3">{day(r.generatedAt)}</td>
                  <td className="pr-3">{day(r.approvedAt)}</td>
                  <td className="pr-3">{r.regenCount}</td>
                  <td className="pr-3">{r.costLabel}</td>
                  <td className="pr-3">
                    <div className="font-medium text-foreground">{r.video.voiceLabel} · {r.video.stateLabel}</div>
                    <ul className="text-muted-foreground">
                      {r.video.hasRender ? <li>{r.video.attempts} {r.video.attempts === 1 ? "attempt" : "attempts"}</li> : null}
                      {r.video.errorCode ? <li>Code: <span className="font-mono">{r.video.errorCode}</span></li> : null}
                      <li>Render cost {r.video.renderCostLabel}</li>
                    </ul>
                  </td>
                  <td className="pr-3">
                    <div className="font-medium text-foreground">{r.taggedLeads} in all</div>
                    <ul className="text-muted-foreground">
                      {r.ads.map((a) => (
                        <li key={a.id}><span className="font-mono">{a.code}</span> {a.label}{a.current ? "" : " (older)"}: {a.leads}</li>
                      ))}
                    </ul>
                    {r.unplaced > 0 ? <div className="text-muted-foreground">{r.unplaced} linked to an ad that was removed</div> : null}
                  </td>
                  <td className="pr-3">{r.untagged}</td>
                  <td className="min-w-56"><Regenerate row={r} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <LeadDbAccounts accounts={accounts} readError={accountsError} />

      <LinkMissing owners={owners} />
    </>
  );
}
