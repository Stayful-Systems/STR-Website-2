"use client";

import { useActionState, useState } from "react";
import { academyLinkAction, academyRemindersAction, academyUnlinkAction, type AcademyActionState } from "./academy-actions";

/**
 * Batch 31a, Phase 6: the Academy purchases table and its three actions. Each answers in place (useActionState);
 * Run is offered only after a clean dry run for the same input on this page, and asks first (TidyPanel pattern).
 */

export interface AcademyRow {
  id: string;
  email: string;
  amount: string;
  paid: string;
  linkedTo: string | null;
  linkedBy: string | null;
  status: string;
  trialEnd: string;
  reminderSent: string;
  flags: string[];
  canLink: boolean;
  canUnlink: boolean;
}

const button = "rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50";
const input = "rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground";

function Result({ state }: { state: AcademyActionState }) {
  if (!state) return null;
  return (
    <div className="mt-3 text-sm">
      <p className={state.ok ? "text-foreground" : "text-destructive"}>{state.ok ? state.message : `Failed: ${state.message}`}</p>
      {state.body?.lines && state.body.lines.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
          {state.body.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
      {state.body?.previews?.map((p, i) => (
        <details key={i} className="mt-2 rounded-md border border-border p-2">
          <summary className="cursor-pointer text-foreground">
            Email to {p.title}: &ldquo;{p.subject}&rdquo;
          </summary>
          <pre className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">{p.text}</pre>
        </details>
      ))}
    </div>
  );
}

function RunButtons({ pending, canRun, confirmText }: { pending: boolean; canRun: boolean; confirmText: string }) {
  return (
    <>
      <button type="submit" name="apply" value="0" disabled={pending} className={button}>
        {pending ? "Working…" : "Dry run"}
      </button>
      <button
        type="submit"
        name="apply"
        value="1"
        disabled={pending || !canRun}
        className={button}
        onClick={(e) => {
          if (!window.confirm(confirmText)) e.preventDefault();
        }}
      >
        Run
      </button>
    </>
  );
}

export function AcademyPanelClient({ rows }: { rows: AcademyRow[] }) {
  const linkable = rows.filter((r) => r.canLink);
  const unlinkable = rows.filter((r) => r.canUnlink);

  const [linkId, setLinkId] = useState("");
  const [memberEmail, setMemberEmail] = useState("");
  const [unlinkId, setUnlinkId] = useState("");
  const [linkState, linkAction, linkPending] = useActionState<AcademyActionState, FormData>(academyLinkAction, null);
  const [unlinkState, unlinkAction, unlinkPending] = useActionState<AcademyActionState, FormData>(academyUnlinkAction, null);
  const [remState, remAction, remPending] = useActionState<AcademyActionState, FormData>(academyRemindersAction, null);

  const linkKey = `${linkId}|${memberEmail.trim().toLowerCase()}`;
  const canLinkRun = Boolean(linkState?.ok && linkState.dry && linkState.clean && linkState.key === linkKey);
  const canUnlinkRun = Boolean(unlinkState?.ok && unlinkState.dry && unlinkState.clean && unlinkState.key === unlinkId);
  const canRemRun = Boolean(remState?.ok && remState.dry);

  return (
    <div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="py-1 pr-3 font-medium">Email</th>
              <th className="py-1 pr-3 font-medium">Amount</th>
              <th className="py-1 pr-3 font-medium">Paid</th>
              <th className="py-1 pr-3 font-medium">Linked to</th>
              <th className="py-1 pr-3 font-medium">Trial</th>
              <th className="py-1 pr-3 font-medium">Trial ends</th>
              <th className="py-1 pr-3 font-medium">Reminder sent</th>
              <th className="py-1 pr-3 font-medium">Flags</th>
              <th className="py-1 font-medium" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="py-3 text-muted-foreground">
                  No Academy purchases yet.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-border align-top">
                <td className="py-1.5 pr-3">{r.email}</td>
                <td className="py-1.5 pr-3">{r.amount}</td>
                <td className="py-1.5 pr-3 whitespace-nowrap">{r.paid}</td>
                <td className="py-1.5 pr-3">
                  {r.linkedTo ?? "—"}
                  {r.linkedTo && r.linkedBy && <span className="ml-1 text-xs text-muted-foreground">({r.linkedBy})</span>}
                </td>
                <td className="py-1.5 pr-3">{r.status}</td>
                <td className="py-1.5 pr-3 whitespace-nowrap">{r.trialEnd}</td>
                <td className="py-1.5 pr-3 whitespace-nowrap">{r.reminderSent}</td>
                <td className="py-1.5 pr-3">
                  {r.flags.map((f) => (
                    <span key={f} className={`mr-1 inline-block rounded px-1.5 py-0.5 text-xs ${f === "chase" ? "bg-amber-100 text-amber-900" : "bg-muted text-foreground"}`}>
                      {f}
                    </span>
                  ))}
                </td>
                <td className="py-1.5 whitespace-nowrap">
                  {r.canLink && (
                    <button type="button" className="text-xs font-medium text-primary hover:underline" onClick={() => setLinkId(r.id)}>
                      Link…
                    </button>
                  )}
                  {r.canUnlink && (
                    <button type="button" className="text-xs font-medium text-primary hover:underline" onClick={() => setUnlinkId(r.id)}>
                      Unlink…
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border bg-background p-4">
          <h3 className="text-base font-semibold text-foreground">Link to member</h3>
          <p className="mt-1 text-xs text-muted-foreground">Starts the free Pro trial on that account with the card the Academy was paid with. Dry run first: it shows exactly what would happen and changes nothing.</p>
          <form action={linkAction} className="mt-3 flex flex-wrap items-center gap-2">
            <select name="purchase_id" value={linkId} onChange={(e) => setLinkId(e.target.value)} className={input}>
              <option value="">Purchase…</option>
              {linkable.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.email} · {r.paid}
                </option>
              ))}
            </select>
            <input name="member_email" type="email" placeholder="Member's sign-in email" value={memberEmail} onChange={(e) => setMemberEmail(e.target.value)} className={`${input} min-w-[220px]`} />
            <RunButtons pending={linkPending} canRun={canLinkRun} confirmText="Link this purchase and start the free trial now? The member's card is charged when the trial ends unless they cancel." />
          </form>
          <Result state={linkState} />
        </div>

        <div className="rounded-xl border border-border bg-background p-4">
          <h3 className="text-base font-semibold text-foreground">Unlink</h3>
          <p className="mt-1 text-xs text-muted-foreground">Only while nothing has been charged on the trial. Cancels the trial now and frees the purchase to be linked to another account (a fresh trial).</p>
          <form action={unlinkAction} className="mt-3 flex flex-wrap items-center gap-2">
            <select name="purchase_id" value={unlinkId} onChange={(e) => setUnlinkId(e.target.value)} className={input}>
              <option value="">Linked purchase…</option>
              {unlinkable.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.email} → {r.linkedTo ?? "—"}
                </option>
              ))}
            </select>
            <RunButtons pending={unlinkPending} canRun={canUnlinkRun} confirmText="Unlink this purchase and cancel its trial now?" />
          </form>
          <Result state={unlinkState} />
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-border bg-background p-4">
        <h3 className="text-base font-semibold text-foreground">Academy reminders</h3>
        <p className="mt-1 text-xs text-muted-foreground">The daily cron (06:47 UTC): links purchases whose email now matches a confirmed account, then sends the reminder before the first charge. Dry run first: it sends and changes nothing.</p>
        <form action={remAction} className="mt-3 flex flex-wrap items-center gap-2">
          <RunButtons pending={remPending} canRun={canRemRun} confirmText="Run the Academy cron now? It links matching purchases and sends today's reminder emails." />
        </form>
        <Result state={remState} />
      </div>
    </div>
  );
}
