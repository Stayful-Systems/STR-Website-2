"use client";

import { useState, useTransition } from "react";
import type { DomainsAdminData } from "@/lib/domains/admin-server";
import { money, renewalLine, type AdminKind, type DomainListRow } from "@/lib/domains/admin-view";
import { DOMAIN_KEYS } from "@/lib/domains/settings";
import type { AdminResult } from "@/lib/domains/admin-run";
import { dryRunDomainAction, dryRunDomainSettingAction, runDomainAction, saveDomainSettingAction } from "./domain-actions";

const button = "rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-60";
const primary = "rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60";
const input = "mt-1 block rounded-md border border-border bg-background px-2 py-1.5 text-sm";

const LABEL: Record<AdminKind, string> = { buy: "Buy", retry: "Retry", release: "Release", renew: "Renew", dont_renew: "Don’t renew" };

const when = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");

/** Customer website domains (Batch 33): the list, the renewals, and the three settings. Every action is a Dry run first. */
export function DomainsPanel({ data }: { data: DomainsAdminData }) {
  const renewals = data.rows.filter((r) => r.renewalDue);
  return (
    <section className="mt-6 space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Website domains</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          When a member approves their website we buy &lt;company&gt;management.co.uk (Stayful holds it), connect it with HTTPS and move the site onto it. Year one is free to the member. Buying is {data.registrarOn ? "set up" : "NOT set up (DOMAINS_REGISTRAR)"}; Vercel is {data.vercelOn ? "set up" : "NOT set up (DOMAINS_VERCEL_*)"}. Spent today: {money(data.usedTodayPence)} of {money(data.settings.dailySpendCapPence)}.
        </p>
      </div>
      {data.readError ? <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">Read failed (schema.sql not run?): {data.readError}</p> : null}
      {!data.available ? <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">The service role is not configured, so domains cannot be listed or changed here.</p> : null}
      <SettingsForm data={data} />
      {renewals.length > 0 ? <Renewals rows={renewals} disabled={!data.available} /> : null}
      <DomainList rows={data.rows} disabled={!data.available} />
    </section>
  );
}

function Result({ result }: { result: AdminResult }) {
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

/** One button: Dry run, then (only for that same action on that same domain) Run. */
function Act({ kind, id, disabled }: { kind: AdminKind; id: string; disabled: boolean }) {
  const [result, setResult] = useState<AdminResult | null>(null);
  const [dryPassed, setDryPassed] = useState(false);
  const [pending, start] = useTransition();
  return (
    <div className="inline-block align-top">
      <div className="flex gap-1.5">
        <button type="button" className={button} disabled={disabled || pending} onClick={() => start(async () => { const r = await dryRunDomainAction(kind, id); setResult(r); setDryPassed(r.canRun); })}>
          Dry run: {LABEL[kind]}
        </button>
        {dryPassed ? (
          <button type="button" className={primary} disabled={disabled || pending} onClick={() => start(async () => { const r = await runDomainAction(kind, id); setResult(r); setDryPassed(false); })}>
            Run {LABEL[kind]}
          </button>
        ) : null}
      </div>
      {result ? <Result result={result} /> : null}
    </div>
  );
}

function DomainList({ rows, disabled }: { rows: DomainListRow[]; disabled: boolean }) {
  if (rows.length === 0) return <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">No website has chosen a web address yet.</p>;
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card p-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="py-1 pr-3">Domain</th>
            <th className="py-1 pr-3">Site · member</th>
            <th className="py-1 pr-3">Bought</th>
            <th className="py-1 pr-3">Cost</th>
            <th className="py-1 pr-3">Renews</th>
            <th className="py-1 pr-3">Status</th>
            <th className="py-1">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-border align-top">
              <td className="py-2 pr-3 font-medium text-foreground">{r.name}</td>
              <td className="py-2 pr-3 text-xs">{r.siteSlug ? `/s/${r.siteSlug}` : "—"}{r.company ? ` · ${r.company}` : ""}<br />{r.memberEmail ?? "—"}</td>
              <td className="py-2 pr-3">{when(r.boughtAt)}</td>
              <td className="py-2 pr-3">{money(r.costPence)}</td>
              <td className="py-2 pr-3">{when(r.expiresAt)}</td>
              <td className="py-2 pr-3 text-xs">
                <span className="font-medium text-foreground">{r.status}</span>
                <br />
                <span className="text-muted-foreground">{r.why}</span>
                {r.lastError ? <><br /><span className="font-mono text-destructive">{r.lastError}</span></> : null}
              </td>
              <td className="py-2">
                <div className="space-y-2">
                  {r.actions.map((k) => (
                    <Act key={k} kind={k} id={r.id} disabled={disabled} />
                  ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Renewals({ rows, disabled }: { rows: DomainListRow[]; disabled: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-base font-semibold text-foreground">Renewals due (within 30 days)</h3>
      <p className="mt-1 text-xs text-muted-foreground">If nobody decides by 7 days before expiry, a domain renews automatically only if its website is live and not switched off and the renewal fits within the daily cap. You are emailed once each year.</p>
      <ul className="mt-3 space-y-3">
        {rows.map((r) => (
          <li key={r.id} className="border-t border-border pt-3 text-sm">
            <p className="font-medium text-foreground">{r.name} <span className="font-normal text-muted-foreground">· {money(r.costPence)} to renew · {when(r.expiresAt)}</span></p>
            <p className="text-xs text-muted-foreground">{renewalLine(r)}</p>
            <div className="mt-2 flex flex-wrap gap-3">
              <Act kind="renew" id={r.id} disabled={disabled} />
              <Act kind="dont_renew" id={r.id} disabled={disabled} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const SETTING_FIELDS: Array<{ key: string; label: string; help: string; kind: "switch" | "pence"; current: (d: DomainsAdminData) => string }> = [
  { key: DOMAIN_KEYS.autoBuy, label: "Buy automatically", help: "On: a domain is bought as soon as the member chooses it. Off: you press Buy.", kind: "switch", current: (d) => String(d.settings.autoBuy) },
  { key: DOMAIN_KEYS.dailySpendCapPence, label: "Daily spend cap (pence)", help: "Most Stayful spends on domains, buying and renewing, in a UK day. 0 stops all of it.", kind: "pence", current: (d) => String(d.settings.dailySpendCapPence) },
  { key: DOMAIN_KEYS.chargeOn, label: "Yearly charge", help: "Off (the default): the first year and every year after are free to the member. On: from year two the member is charged what the domain costs. Never at registration.", kind: "switch", current: (d) => String(d.settings.chargeOn) },
];

function SettingsForm({ data }: { data: DomainsAdminData }) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {SETTING_FIELDS.map((f) => (
        <SettingRow key={f.key} field={f} initial={f.current(data)} disabled={!data.available} />
      ))}
    </div>
  );
}

function SettingRow({ field, initial, disabled }: { field: (typeof SETTING_FIELDS)[number]; initial: string; disabled: boolean }) {
  const [value, setValue] = useState(initial);
  const [result, setResult] = useState<AdminResult | null>(null);
  // The value the last dry run passed for: Save is offered only for exactly that.
  const [dryFor, setDryFor] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <label className="block text-sm font-medium text-foreground">
        {field.label}
        {field.kind === "switch" ? (
          <select className={input} value={value} onChange={(e) => setValue(e.target.value)} disabled={disabled || pending}>
            <option value="true">On</option>
            <option value="false">Off</option>
          </select>
        ) : (
          <input className={input} inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} disabled={disabled || pending} />
        )}
      </label>
      <p className="mt-1 text-xs text-muted-foreground">{field.help}</p>
      <div className="mt-3 flex gap-1.5">
        <button type="button" className={button} disabled={disabled || pending} onClick={() => start(async () => { const r = await dryRunDomainSettingAction(field.key, value); setResult(r); setDryFor(r.canRun ? value : null); })}>
          Dry run
        </button>
        {dryFor === value ? (
          <button type="button" className={primary} disabled={disabled || pending} onClick={() => start(async () => { const r = await saveDomainSettingAction(field.key, value); setResult(r); setDryFor(null); })}>
            Save
          </button>
        ) : null}
      </div>
      {result ? <Result result={result} /> : null}
    </div>
  );
}
