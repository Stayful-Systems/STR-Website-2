"use client";

import { useState, useTransition } from "react";
import type { AdSheetAdminRow, AdSheetsAdminView } from "@/lib/ad-sheets/admin-view";
import type { AdSheetAdminResult } from "@/lib/ad-sheets/admin-run";
import { dryRunDisconnectAction, dryRunImportAction, markGuideCheckedAction, runDisconnectAction, runImportAction } from "./actions";

const button = "rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-60";
const WHEN = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "2-digit", timeZone: "Europe/London" });
const WHEN_TIME = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
const day = (iso: string | null) => (iso ? WHEN.format(new Date(iso)) : "—");
const dayTime = (iso: string | null) => (iso ? WHEN_TIME.format(new Date(iso)) : "—");

function Result({ result }: { result: AdSheetAdminResult | null }) {
  if (!result) return null;
  return (
    <div role="status" className="mt-1">
      <p className={result.ok ? "text-xs text-foreground" : "text-xs text-destructive"}>{result.message}</p>
      {result.lines.length > 0 ? (
        <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
          {result.lines.map((l, i) => (
            <li key={i} className="whitespace-pre-wrap">{l}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Dry run / Run (Run asks first) for the import: every sheet, or one. */
function ImportButtons({ linkId, label }: { linkId?: string; label: string }) {
  const [result, setResult] = useState<AdSheetAdminResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" disabled={pending} className={button} onClick={() => start(async () => setResult(await dryRunImportAction(linkId)))}>
          {pending ? "Working…" : `Dry run${label}`}
        </button>
        <button
          type="button"
          disabled={pending}
          className={button}
          onClick={() => {
            if (!window.confirm("Read the sheet now and save its new rows as leads? Operators may be emailed about new leads.")) return;
            start(async () => setResult(await runImportAction(linkId)));
          }}
        >
          Run{label}
        </button>
      </div>
      <Result result={result} />
    </div>
  );
}

/** Disconnect with its own Dry run. */
function Disconnect({ row }: { row: AdSheetAdminRow }) {
  const [result, setResult] = useState<AdSheetAdminResult | null>(null);
  const [pending, start] = useTransition();
  if (!row.canDisconnect) return <span className="text-xs text-muted-foreground">Disconnected</span>;
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" disabled={pending} className={button} onClick={() => start(async () => setResult(await dryRunDisconnectAction(row.linkId)))}>
          Disconnect dry run
        </button>
        <button
          type="button"
          disabled={pending}
          className={button}
          onClick={() => {
            if (!window.confirm("Disconnect this sheet? It stops being read; the rows and leads already saved are kept.")) return;
            start(async () => setResult(await runDisconnectAction(row.linkId)));
          }}
        >
          Disconnect
        </button>
      </div>
      <Result result={result} />
    </div>
  );
}

function Guide({ view }: { view: AdSheetsAdminView }) {
  const [result, setResult] = useState<AdSheetAdminResult | null>(null);
  const [pending, start] = useTransition();
  const { checkedAt, due } = view.guide;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4">
      <p className="text-sm text-foreground">
        Guide screenshots last checked: {checkedAt ? day(checkedAt) : "never"}
        {due ? <span className="ml-1 font-semibold text-destructive">, due</span> : null}
      </p>
      <button type="button" disabled={pending} className={button} onClick={() => start(async () => setResult(await markGuideCheckedAction()))}>
        Mark checked
      </button>
      <Result result={result} />
    </div>
  );
}

export function AdSheetsPanel({ view }: { view: AdSheetsAdminView }) {
  return (
    <div className="mt-4">
      <p className="text-sm text-foreground">
        Lead forms switch (ad_sheets_enabled): <strong>{view.switchOn ? "ON" : "OFF"}</strong>
      </p>
      <Guide view={view} />

      <section className="mt-6 rounded-xl border border-border bg-card p-5">
        <h2 className="text-base font-semibold text-foreground">Import</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          The hourly cron reads every connected sheet. A Dry run lists what each sheet would save and writes and sends nothing. Counts and codes only.
        </p>
        <div className="mt-3">
          <ImportButtons label=" (all sheets)" />
        </div>
      </section>

      <section className="mt-6 overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="border-b border-border text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Operator</th>
              <th className="px-3 py-2 font-medium">State</th>
              <th className="px-3 py-2 font-medium">Last row read</th>
              <th className="px-3 py-2 font-medium">Last import</th>
              <th className="px-3 py-2 font-medium">Error code</th>
              <th className="px-3 py-2 font-medium">Untagged</th>
              <th className="px-3 py-2 font-medium">Rows imported</th>
              <th className="px-3 py-2 font-medium">Columns changed</th>
              <th className="px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-3 py-4 text-sm text-muted-foreground">No sheet is connected yet.</td>
              </tr>
            ) : (
              view.rows.map((r) => (
                <tr key={r.linkId} className="border-b border-border align-top last:border-0">
                  <td className="px-3 py-2">{r.ownerLabel}</td>
                  <td className="px-3 py-2">{r.stateLabel}</td>
                  <td className="px-3 py-2 tabular-nums">{r.lastRowRead}</td>
                  <td className="px-3 py-2">{dayTime(r.lastImportAt)}</td>
                  <td className="px-3 py-2">{r.errorCode || "—"}</td>
                  <td className="px-3 py-2 tabular-nums">{r.untaggedCount}</td>
                  <td className="px-3 py-2 tabular-nums">{r.rowsImported}</td>
                  <td className="px-3 py-2">{day(r.columnsChangedAt)}</td>
                  <td className="space-y-2 px-3 py-2">
                    {r.canImport ? <ImportButtons linkId={r.linkId} label="" /> : null}
                    <Disconnect row={r} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
