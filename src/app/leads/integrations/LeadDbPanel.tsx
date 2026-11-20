"use client";

import { useActionState } from "react";
import { sendCodeAction, confirmCodeAction, testLeadAction, disconnectLeadDbAction, type LeadDbState } from "./leaddb-actions";
import { leadDbMessage, GET_THE_LEAD_DATABASE_URL, NOT_AVAILABLE } from "@/lib/leaddb/messages";

const INITIAL: LeadDbState = {};

interface Props {
  /** False when the link is not configured on this deployment. */
  available: boolean;
  /** Owners connect; a team member sees the status only. */
  canEdit: boolean;
  link: {
    status: "code_sent" | "active" | "revoked" | "error";
    email: string;
    leadType: "management" | "guaranteed_rent" | null;
    lastError: string | null;
    connectedAt: string | null;
  } | null;
}

const input = "mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground";
const primary = "rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60";
const quiet = "rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60";

function Feedback({ state }: { state: LeadDbState }) {
  return (
    <>
      {state.error ? <p role="alert" className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">{state.error}</p> : null}
      {state.noAccount ? (
        <p className="mt-2 text-xs text-muted-foreground">
          No account yet?{" "}
          <a href={GET_THE_LEAD_DATABASE_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-foreground underline underline-offset-2">Get the lead database</a>
          . Your leads here keep working either way.
        </p>
      ) : null}
      {state.notice ? <p role="status" className="mt-3 text-xs text-muted-foreground">{state.notice}</p> : null}
    </>
  );
}

/**
 * Put your website leads into your lead database account (Batch 32): login
 * email, then "Send code", then the code. Works in three steps and shows the
 * last problem in plain English. The lead stays in Stayful Intelligence too,
 * and nothing here costs anything.
 */
export function LeadDbPanel({ available, canEdit, link }: Props) {
  const [sendState, sendAction, sending] = useActionState(sendCodeAction, INITIAL);
  const [confirmState, confirmAction, confirming] = useActionState(confirmCodeAction, INITIAL);
  const [testState, testAction, testing] = useActionState(testLeadAction, INITIAL);
  const [discState, discAction, disconnecting] = useActionState(disconnectLeadDbAction, INITIAL);

  const active = link?.status === "active" || link?.status === "error";
  const waiting = link?.status === "code_sent";

  return (
    <section className="rounded-xl border border-border p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">Lead database</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Every landlord who fills in your website form also lands in your own lead database account, with their income report once
            it is ready. It is your lead: you are never charged for it and it is never given or sold to anyone else.
          </p>
        </div>
        {active ? (
          <span className="rounded-full bg-success/15 px-2.5 py-1 text-xs font-medium text-success">Connected</span>
        ) : null}
      </header>

      {!available ? (
        <p className="mt-4 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">{NOT_AVAILABLE}</p>
      ) : !canEdit ? (
        <p className="mt-4 text-xs text-muted-foreground">
          {active ? "Connected. Website leads also go into the account owner's lead database." : "Not connected. Only the account owner can connect it."}
        </p>
      ) : active ? (
        <div className="mt-4 space-y-3">
          <p className="text-xs text-muted-foreground">
            Connected to the lead database account for <span className="font-medium text-foreground">{link?.email}</span>
            {link?.leadType ? <> ({link.leadType === "guaranteed_rent" ? "Guaranteed Rent" : "Management"} leads)</> : null}.
          </p>
          {link?.lastError ? (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">{leadDbMessage(link.lastError)}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <form action={testAction}>
              <button type="submit" disabled={testing} className={quiet}>{testing ? "Sending…" : "Send a test lead"}</button>
            </form>
            <form action={discAction}>
              <button type="submit" disabled={disconnecting} className={quiet}>{disconnecting ? "Disconnecting…" : "Disconnect"}</button>
            </form>
          </div>
          <Feedback state={testState} />
          <Feedback state={discState} />
        </div>
      ) : waiting ? (
        <div className="mt-4 space-y-3">
          <form action={confirmAction} className="space-y-3">
            <label className="block">
              <span className="text-xs font-medium text-foreground">The 6-digit code we emailed to {link?.email}</span>
              <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required placeholder="123456" className={input} />
            </label>
            <button type="submit" disabled={confirming} className={primary}>{confirming ? "Checking…" : "Connect"}</button>
          </form>
          <Feedback state={confirmState} />
          <form action={sendAction} className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <input type="hidden" name="email" value={link?.email ?? ""} />
            <span>No email?</span>
            <button type="submit" disabled={sending} className="font-medium text-foreground underline underline-offset-2">{sending ? "Sending…" : "Send again"}</button>
          </form>
          <Feedback state={sendState} />
        </div>
      ) : (
        <div className="mt-4">
          <form action={sendAction} className="space-y-3">
            <label className="block">
              <span className="text-xs font-medium text-foreground">The login email of your lead database account</span>
              <input name="email" type="email" required defaultValue={link?.email ?? ""} placeholder="you@yourcompany.co.uk" className={input} />
              <span className="mt-1 block text-xs text-muted-foreground">We email a code to that address to prove the account is yours. We never see your password.</span>
            </label>
            <button type="submit" disabled={sending} className={primary}>{sending ? "Sending…" : "Send code"}</button>
          </form>
          <Feedback state={sendState} />
        </div>
      )}
    </section>
  );
}
