"use client";

import { useActionState, useState, useTransition } from "react";
import type { WebsitesAdminData } from "@/lib/websites/admin-server";
import { SETTING_LIMITS } from "@/lib/websites/invite-run";
import {
  dryRunGiveWebsiteAction,
  dryRunSiteStatusAction,
  giveWebsiteAction,
  saveWebsiteSettingsAction,
  setSiteStatusAction,
  type WebsiteActionResult,
  type WebsiteSettingsState,
} from "./website-actions";

const button = "rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-60";
const primary = "rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60";
const input = "mt-1 block rounded-md border border-border bg-background px-2 py-1.5 text-sm";

const MARK = { pass: "Yes", fail: "No", skip: "—" } as const;

/** Customer websites (Batch 31): give one, the site list with pause / unpause, and the five settings. */
export function WebsitesPanel({ data }: { data: WebsitesAdminData }) {
  return (
    <section className="mt-6 space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Customer websites</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          A website is given by invitation to a management company’s account owner. It starts invited, the member sets it up from /leads, and it lives at /s/&lt;slug&gt;. No lead contact details or addresses are shown here.
        </p>
        <p className="mt-1 text-xs"><a href="/admin/websites" className="underline">Open the website console</a> (every site, switch-off and deletion, change requests).</p>
      </div>
      {data.readError ? <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">Read failed (schema.sql not run?): {data.readError}</p> : null}
      {!data.available ? <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">The service role is not configured, so websites cannot be listed or changed here.</p> : null}
      <div className="grid gap-5 md:grid-cols-2">
        <GiveWebsite disabled={!data.available} />
        <SettingsForm settings={data.settings} disabled={!data.available} />
      </div>
      <SiteList data={data} />
    </section>
  );
}

function Checklist({ result }: { result: WebsiteActionResult }) {
  return (
    <div className="mt-3 space-y-2 text-xs">
      <p className={result.ok ? "text-foreground" : "text-destructive"}>{result.message}</p>
      {result.checklist ? (
        <table className="w-full">
          <tbody>
            {result.checklist.map((c) => (
              <tr key={c.key} className="border-t border-border align-top">
                <td className="py-1 pr-2 font-medium text-foreground">{c.label}</td>
                <td className={`py-1 pr-2 ${c.state === "fail" ? "text-destructive" : "text-foreground"}`}>{MARK[c.state]}</td>
                <td className="py-1 text-muted-foreground">{c.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

/** Give a website: a dry run (a checklist, nothing written), then Run. */
function GiveWebsite({ disabled }: { disabled: boolean }) {
  const [email, setEmail] = useState("");
  const [slug, setSlug] = useState("");
  const [result, setResult] = useState<WebsiteActionResult | null>(null);
  // The inputs the last dry run passed for: Run is offered only for exactly those.
  const [dryFor, setDryFor] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const key = `${email.trim().toLowerCase()}|${slug.trim().toLowerCase()}`;
  const runnable = !disabled && dryFor === key;

  const dry = () =>
    start(async () => {
      const r = await dryRunGiveWebsiteAction(email, slug);
      setResult(r);
      setDryFor(r.canRun ? key : null);
    });
  const run = () => {
    if (!window.confirm(`Give ${email.trim()} a website at /s/${slug.trim().toLowerCase()}?`)) return;
    start(async () => {
      const r = await giveWebsiteAction(email, slug);
      setResult(r);
      setDryFor(null);
      if (r.ok) {
        setEmail("");
        setSlug("");
      }
    });
  };

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h3 className="text-base font-semibold text-foreground">Give a website</h3>
      <p className="mt-1 text-xs text-muted-foreground">Dry run first: it checks the member and the address and writes nothing. Run creates the website (invited) and its hidden lead-form record.</p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="text-xs">
          Member email
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" className={input} />
        </label>
        <label className="text-xs">
          Address (slug)
          <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="acme-lettings" maxLength={40} className={input} />
        </label>
      </div>
      <div className="mt-3 flex gap-2">
        <button type="button" disabled={pending || disabled || !email.trim() || !slug.trim()} onClick={dry} className={button}>
          {pending ? "Working…" : "Dry run"}
        </button>
        <button type="button" disabled={pending || !runnable} onClick={run} className={primary}>
          Run
        </button>
      </div>
      {result ? <Checklist result={result} /> : null}
    </section>
  );
}

/** The five settings. Validated on the server; a bad field changes nothing. */
function SettingsForm({ settings, disabled }: { settings: WebsitesAdminData["settings"]; disabled: boolean }) {
  const [state, action, pending] = useActionState<WebsiteSettingsState, FormData>(saveWebsiteSettingsAction, null);
  const err = (k: string) => (state && !state.ok && state.errors ? (state.errors as Record<string, string | undefined>)[k] : undefined);
  const sel = "mt-1 block rounded-md border border-border bg-background px-2 py-1.5 text-sm";
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h3 className="text-base font-semibold text-foreground">Website settings</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Reports are free (Stayful pays) while charging is off, and it stays off for now. Free reports are counted per UK day; one site’s share is inside the daily total. Changes apply within a minute.
      </p>
      <form action={action} className="mt-3 grid grid-cols-2 gap-3">
        <label className="text-xs">
          Charge for reports
          <select name="reportChargeOn" defaultValue={String(settings.reportChargeOn)} className={sel}>
            <option value="false">Off (free)</option>
            <option value="true">On</option>
          </select>
          {err("reportChargeOn") ? <span className="block text-destructive">{err("reportChargeOn")}</span> : null}
        </label>
        <label className="text-xs">
          Report price (pence)
          <input name="reportPence" type="number" min={SETTING_LIMITS.pence.min} max={SETTING_LIMITS.pence.max} step={1} defaultValue={settings.reportPence} className={`${sel} w-28`} />
          {err("reportPence") ? <span className="block text-destructive">{err("reportPence")}</span> : null}
        </label>
        <label className="text-xs">
          Plan gate
          <select name="planGateOn" defaultValue={String(settings.planGateOn)} className={sel}>
            <option value="false">Off (no plan needed)</option>
            <option value="true">On (paid plan to invite or go live)</option>
          </select>
          {err("planGateOn") ? <span className="block text-destructive">{err("planGateOn")}</span> : null}
        </label>
        <span />
        <label className="text-xs">
          Free reports a day, all sites
          <input name="freeReportsPerDay" type="number" min={SETTING_LIMITS.perDay.min} max={SETTING_LIMITS.perDay.max} step={1} defaultValue={settings.freeReportsPerDay} className={`${sel} w-28`} />
          {err("freeReportsPerDay") ? <span className="block text-destructive">{err("freeReportsPerDay")}</span> : null}
        </label>
        <label className="text-xs">
          Free reports a day, one site
          <input name="freeReportsPerSitePerDay" type="number" min={SETTING_LIMITS.perDay.min} max={SETTING_LIMITS.perDay.max} step={1} defaultValue={settings.freeReportsPerSitePerDay} className={`${sel} w-28`} />
          {err("freeReportsPerSitePerDay") ? <span className="block text-destructive">{err("freeReportsPerSitePerDay")}</span> : null}
        </label>
        <div className="col-span-2 flex items-center gap-3">
          <button
            type="submit"
            disabled={pending || disabled}
            onClick={(e) => {
              const form = e.currentTarget.form;
              const on = form ? (form.elements.namedItem("reportChargeOn") as HTMLSelectElement | null)?.value === "true" : false;
              if (on && !settings.reportChargeOn && !window.confirm("Turn charging ON? Members will be charged for each website report.")) e.preventDefault();
            }}
            className={button}
          >
            {pending ? "Saving…" : "Save settings"}
          </button>
          {state?.message ? <span className={`text-xs ${state.ok ? "text-foreground" : "text-destructive"}`}>{state.message}</span> : null}
        </div>
      </form>
      {state?.changes && state.changes.length > 0 ? (
        <ul className="mt-2 list-disc pl-5 text-xs text-muted-foreground">
          {state.changes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** Every site with its numbers, and Pause / Unpause (dry run first, then confirm). */
function SiteList({ data }: { data: WebsitesAdminData }) {
  const [plan, setPlan] = useState<{ id: string; action: "pause" | "unpause"; result: WebsiteActionResult } | null>(null);
  const [done, setDone] = useState<WebsiteActionResult | null>(null);
  const [pending, start] = useTransition();

  const dry = (id: string, action: "pause" | "unpause") =>
    start(async () => {
      setDone(null);
      setPlan({ id, action, result: await dryRunSiteStatusAction(id, action) });
    });
  const confirm = () => {
    if (!plan) return;
    start(async () => {
      setDone(await setSiteStatusAction(plan.id, plan.action));
      setPlan(null);
    });
  };

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h3 className="text-base font-semibold text-foreground">Websites</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Leads are the last seven days. Free today counts the UK day{data.ukDay ? ` (${data.ukDay})` : ""}; held is the backlog waiting for the daily limit. Pausing makes the public site answer 404 and deletes nothing.
      </p>
      {done ? <p className={`mt-2 text-xs ${done.ok ? "text-foreground" : "text-destructive"}`}>{done.message}</p> : null}
      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="py-1">Slug</th>
            <th className="py-1">Member</th>
            <th className="py-1">Status</th>
            <th className="py-1">Leads (7 days)</th>
            <th className="py-1">Free today</th>
            <th className="py-1">Held</th>
            <th className="py-1" />
          </tr>
        </thead>
        <tbody>
          {data.sites.length === 0 ? (
            <tr>
              <td colSpan={7} className="py-2 text-muted-foreground">
                No websites yet.
              </td>
            </tr>
          ) : (
            data.sites.map((s) => {
              const open = plan?.id === s.id ? plan : null;
              return (
                <tr key={s.id} className="border-t border-border align-top">
                  <td className="py-1.5">/s/{s.slug}</td>
                  <td className="py-1.5">{s.member}</td>
                  <td className="py-1.5">{s.status}</td>
                  <td className="py-1.5">{s.leadsThisWeek}</td>
                  <td className="py-1.5">{s.freeToday}</td>
                  <td className="py-1.5">{s.heldBacklog}</td>
                  <td className="py-1.5 text-right">
                    {s.status === "live" || s.status === "paused" ? (
                      <button type="button" disabled={pending} onClick={() => dry(s.id, s.status === "live" ? "pause" : "unpause")} className={button}>
                        {s.status === "live" ? "Pause…" : "Unpause…"}
                      </button>
                    ) : null}
                    {open ? (
                      <div className="mt-2 space-y-1 rounded-md bg-muted p-2 text-left text-xs">
                        <p className={open.result.ok ? "font-medium text-foreground" : "text-destructive"}>{open.result.message}</p>
                        <ul className="list-disc pl-4 text-muted-foreground">{(open.result.lines ?? []).map((l) => <li key={l}>{l}</li>)}</ul>
                        <div className="flex gap-2 pt-1">
                          {open.result.canRun ? (
                            <button type="button" disabled={pending} onClick={confirm} className={primary}>
                              {open.action === "pause" ? "Confirm pause" : "Confirm unpause"}
                            </button>
                          ) : null}
                          <button type="button" disabled={pending} onClick={() => setPlan(null)} className={button}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </section>
  );
}
