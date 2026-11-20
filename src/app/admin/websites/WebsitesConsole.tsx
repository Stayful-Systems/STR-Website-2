"use client";

import { useState, useTransition } from "react";
// Types only from grace-admin: its runtime loads server-only modules, which must not reach the browser bundle.
import type { ConsoleKind, ConsoleResult, ConsoleSite } from "@/lib/websites/grace-admin";
import type { GraceSettings } from "@/lib/websites/grace-settings";
import {
  dryRunConsoleAction,
  dryRunGraceSettingAction,
  requestScreenshotAction,
  runConsoleAction,
  saveGraceSettingAction,
  setRequestStatusAction,
  type SettingResult,
} from "./console-actions";

const button = "rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-60";
const primary = "rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60";
const input = "mt-1 block rounded-md border border-border bg-background px-2 py-1.5 text-sm";

export interface ConsoleRequest {
  id: string;
  slug: string;
  body: string;
  status: string;
  adminNotes: string;
  createdAt: string;
  hasScreenshot: boolean;
  next: string[];
}

const CONSOLE_LABEL: Record<ConsoleKind, string> = {
  pause: "Pause",
  resume: "Resume",
  switch_off: "Switch off",
  switch_on: "Switch back on",
  export: "Export data",
  delete: "Delete data",
};

const day = (v: string | null) => (v ? v.slice(0, 10) : "—");

/** Which actions a site offers: only those its plan would allow (the server checks again). */
function offered(s: ConsoleSite): ConsoleKind[] {
  if (s.deleted) return ["export"];
  if (s.switchedOff) return ["switch_on", "export", "delete"];
  if (s.status === "live") return ["pause", "switch_off", "export"];
  if (s.status === "paused") return ["resume", "switch_off", "export"];
  return ["switch_off", "export"];
}

export function WebsitesConsole({ sites, requests, settings, readError }: { sites: ConsoleSite[]; requests: ConsoleRequest[]; settings: GraceSettings; readError: string | null }) {
  return (
    <div className="mt-4 space-y-6">
      {readError ? <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">Read failed (schema.sql not run?): {readError}</p> : null}
      <SiteTable sites={sites} />
      <Requests requests={requests} />
      <Settings settings={settings} />
    </div>
  );
}

/** Every site, and its actions: Dry run first; Run only for the same site and action the dry run passed for. */
function SiteTable({ sites }: { sites: ConsoleSite[] }) {
  const [open, setOpen] = useState<{ id: string; kind: ConsoleKind } | null>(null);
  const [dry, setDry] = useState<ConsoleResult | null>(null);
  // The site and action the last dry run passed for: Run is offered only for exactly those.
  const [dryFor, setDryFor] = useState<string | null>(null);
  const [done, setDone] = useState<ConsoleResult | null>(null);
  const [pending, start] = useTransition();

  const choose = (id: string, kind: ConsoleKind) => {
    setOpen({ id, kind });
    setDry(null);
    setDryFor(null);
    setDone(null);
  };
  const runDry = () => {
    if (!open) return;
    start(async () => {
      const r = await dryRunConsoleAction(open.kind, open.id);
      setDry(r);
      setDryFor(r.canRun ? `${open.id}:${open.kind}` : null);
    });
  };
  const run = () => {
    if (!open || dryFor !== `${open.id}:${open.kind}`) return;
    if (open.kind === "delete" && !window.confirm("Delete this website’s data? This cannot be undone.")) return;
    start(async () => {
      const r = await runConsoleAction(open.kind, open.id);
      setDone(r);
      setDry(null);
      setDryFor(null);
      if (r.ok && r.data) {
        const url = URL.createObjectURL(new Blob([r.data], { type: "application/json" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = `website-${open.id.slice(0, 8)}.json`;
        a.click();
        URL.revokeObjectURL(url);
      }
    });
  };

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h2 className="text-base font-semibold text-foreground">Websites</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Status, dates and warnings are worked out now, from the same rules the daily job uses, so a login that cancels a switch-off shows here at once. Switching off only changes the status: leads, reports and deliveries carry on. Delete is only for a switched-off site.
      </p>
      {done ? (
        <div className={`mt-2 text-xs ${done.ok ? "text-foreground" : "text-destructive"}`}>
          <p>{done.message}</p>
          {done.data ? <textarea readOnly value={done.data} rows={8} className="mt-2 w-full rounded-md border border-border bg-background p-2 font-mono text-xs" /> : null}
        </div>
      ) : null}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-1 pr-2">Site</th>
              <th className="py-1 pr-2">Member</th>
              <th className="py-1 pr-2">Status</th>
              <th className="py-1 pr-2">Domain</th>
              <th className="py-1 pr-2">Leads (30 days)</th>
              <th className="py-1 pr-2">Last login</th>
              <th className="py-1 pr-2">Last enquiry</th>
              <th className="py-1 pr-2">Warnings sent</th>
              <th className="py-1 pr-2">Switch-off</th>
              <th className="py-1 pr-2">Delete</th>
              <th className="py-1 pr-2">Requests (new / open)</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {sites.length === 0 ? (
              <tr>
                <td colSpan={12} className="py-2 text-muted-foreground">No websites yet.</td>
              </tr>
            ) : (
              sites.map((s) => {
                const here = open?.id === s.id ? open : null;
                return (
                  <tr key={s.id} className="border-t border-border align-top">
                    <td className="py-1.5 pr-2">/s/{s.slug}</td>
                    <td className="py-1.5 pr-2">{s.member}</td>
                    <td className="py-1.5 pr-2">{s.display}{s.reason && !s.deleted ? ` (${s.reason})` : ""}</td>
                    <td className="py-1.5 pr-2">{s.domain ?? "—"}</td>
                    <td className="py-1.5 pr-2">{s.leads30}</td>
                    <td className="py-1.5 pr-2">{day(s.lastLogin)}</td>
                    <td className="py-1.5 pr-2">{day(s.lastEnquiry)}</td>
                    <td className="py-1.5 pr-2">{s.warningsSent}</td>
                    <td className="py-1.5 pr-2">{s.switchOffOn ?? "—"}</td>
                    <td className="py-1.5 pr-2">{s.deleteOn ?? "—"}</td>
                    <td className="py-1.5 pr-2">{s.requestsNew} / {s.requestsOpen}</td>
                    <td className="py-1.5">
                      <div className="flex flex-wrap justify-end gap-1">
                        {offered(s).map((k) => (
                          <button key={k} type="button" disabled={pending} onClick={() => choose(s.id, k)} className={button}>{CONSOLE_LABEL[k]}…</button>
                        ))}
                      </div>
                      {here ? (
                        <div className="mt-2 space-y-1 rounded-md bg-muted p-2 text-left text-xs">
                          <p className="font-medium text-foreground">{CONSOLE_LABEL[here.kind]} /s/{s.slug}</p>
                          <div className="flex gap-2 pt-1">
                            <button type="button" disabled={pending} onClick={runDry} className={button}>{pending ? "Working…" : "Dry run"}</button>
                            <button type="button" disabled={pending || dryFor !== `${here.id}:${here.kind}`} onClick={run} className={primary}>Run</button>
                            <button type="button" disabled={pending} onClick={() => setOpen(null)} className={button}>Cancel</button>
                          </div>
                          {dry ? (
                            <div className="space-y-1 pt-1">
                              <p className={dry.ok ? "font-medium text-foreground" : "text-destructive"}>{dry.message}</p>
                              <ul className="list-disc pl-4 text-muted-foreground">{dry.lines.map((l) => <li key={l}>{l}</li>)}</ul>
                              {dry.emails.length > 0 ? <p className="text-muted-foreground">Emails: {dry.emails.join(" ")}</p> : <p className="text-muted-foreground">No emails are sent.</p>}
                              {dry.removes ? <p className="text-muted-foreground">Removes: {dry.removes.join("; ")}.</p> : null}
                              {dry.keeps ? <p className="text-muted-foreground">Keeps: {dry.keeps.join("; ")}.</p> : null}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Change requests: move one on with a note (done or declined emails the operator once), and see its screenshot for ten minutes. */
function Requests({ requests }: { requests: ConsoleRequest[] }) {
  const [notes, setNotes] = useState<Record<string, string>>(() => Object.fromEntries(requests.map((r) => [r.id, r.adminNotes])));
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();

  const move = (id: string, status: string) =>
    start(async () => {
      const r = await setRequestStatusAction(id, status, notes[id] ?? "");
      setMsg((m) => ({ ...m, [id]: r.ok ? `Saved${r.email && r.email !== "none" ? ` (email ${r.email})` : ""}.` : r.message }));
    });
  const shot = (id: string) =>
    start(async () => {
      const r = await requestScreenshotAction(id);
      if (r.ok && r.url) window.open(r.url, "_blank", "noopener,noreferrer");
      else setMsg((m) => ({ ...m, [id]: r.message ?? "No screenshot." }));
    });

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h2 className="text-base font-semibold text-foreground">Change requests</h2>
      <p className="mt-1 text-xs text-muted-foreground">Done or Not going ahead emails the member once, with your note. A screenshot opens through a link that works for ten minutes.</p>
      {requests.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No requests.</p> : null}
      <ul className="mt-3 space-y-3">
        {requests.map((r) => (
          <li key={r.id} className="rounded-md border border-border p-3 text-sm">
            <p className="text-xs text-muted-foreground">/s/{r.slug} · {day(r.createdAt)} · {r.status.replace("_", " ")}</p>
            <p className="mt-1 whitespace-pre-wrap text-foreground">{r.body}</p>
            <label className="mt-2 block text-xs">
              Note to the member
              <textarea value={notes[r.id] ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))} maxLength={2000} rows={2} className={`${input} w-full`} />
            </label>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {r.next.map((n) => (
                <button key={n} type="button" disabled={pending} onClick={() => move(r.id, n)} className={n === "done" ? primary : button}>
                  {n === "in_progress" ? "Start" : n === "done" ? "Done" : "Not going ahead"}
                </button>
              ))}
              {r.hasScreenshot ? <button type="button" disabled={pending} onClick={() => shot(r.id)} className={button}>Screenshot</button> : null}
              {msg[r.id] ? <span className="text-xs text-muted-foreground">{msg[r.id]}</span> : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

const FIELDS: { field: "abandonDays" | "warningDays" | "deleteAfterDays"; label: string; hint: string }[] = [
  { field: "abandonDays", label: "Days with no login and no lead before a live site is warned", hint: "1 to 3650" },
  { field: "warningDays", label: "Warning emails, days before switch-off", hint: "up to five, like 30,14,3" },
  { field: "deleteAfterDays", label: "Days switched off before the data is deleted", hint: "1 to 3650 (set it to 3650 to pause all deletions)" },
];

/** The three grace settings: a dry run checks the value, then Save. */
function Settings({ settings }: { settings: GraceSettings }) {
  const initial: Record<string, string> = { abandonDays: String(settings.abandonDays), warningDays: settings.warningDays.join(","), deleteAfterDays: String(settings.deleteAfterDays) };
  const [values, setValues] = useState(initial);
  const [results, setResults] = useState<Record<string, SettingResult | undefined>>({});
  const [dryFor, setDryFor] = useState<Record<string, string | undefined>>({});
  const [pending, start] = useTransition();

  const dry = (field: string) =>
    start(async () => {
      const r = await dryRunGraceSettingAction(field, values[field]);
      setResults((x) => ({ ...x, [field]: r }));
      setDryFor((x) => ({ ...x, [field]: r.canRun ? values[field] : undefined }));
    });
  const save = (field: string) =>
    start(async () => {
      const r = await saveGraceSettingAction(field, values[field]);
      setResults((x) => ({ ...x, [field]: r }));
      setDryFor((x) => ({ ...x, [field]: undefined }));
    });

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h2 className="text-base font-semibold text-foreground">Switch-off settings</h2>
      <p className="mt-1 text-xs text-muted-foreground">Changes apply to the next daily run. To stop all switching off, set the first to 3650; to stop all deletion, set the last to 3650.</p>
      <div className="mt-3 space-y-3">
        {FIELDS.map((f) => (
          <div key={f.field} className="text-xs">
            <label>
              {f.label} <span className="text-muted-foreground">({f.hint})</span>
              <input value={values[f.field]} onChange={(e) => { setValues((v) => ({ ...v, [f.field]: e.target.value })); setDryFor((x) => ({ ...x, [f.field]: undefined })); }} className={`${input} w-48`} />
            </label>
            <div className="mt-1 flex items-center gap-2">
              <button type="button" disabled={pending} onClick={() => dry(f.field)} className={button}>Dry run</button>
              <button type="button" disabled={pending || dryFor[f.field] !== values[f.field]} onClick={() => save(f.field)} className={primary}>Save</button>
              {results[f.field] ? <span className={results[f.field]!.ok ? "text-foreground" : "text-destructive"}>{results[f.field]!.message}</span> : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
