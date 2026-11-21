"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { LeadFormQuestion } from "@/lib/ad-packs/angles";
import type { SheetState, SheetStatus } from "@/lib/ad-sheets/connect";
import { NOT_AVAILABLE, SHEET_STEPS, sheetShotUrl } from "@/lib/ad-sheets/messages";
import { connectSheetAction, disconnectSheetAction, loadSheetCardAction, pollSheetAction, readSheetNowAction } from "./sheet-actions";

/**
 * Batch 35 (Phase 7): the "Switch to lead forms" card, shown once the ad pack is
 * approved. Six steps, one action per screen, each with a screenshot slot
 * (public/ad-packs/guide/sheet-<n>.png; a plain box until the file exists) and a
 * "Stuck?" line. The step text is data (src/lib/ad-sheets/messages.ts); every
 * rule (owner only, the switches, one sheet per account) lives in
 * src/lib/ad-sheets/connect.ts. A green tick appears only when Intelligence has
 * confirmed the thing; the browser never decides one. Until the link is active
 * the ads and the guide above stay in website mode.
 */

export type SheetFormAd = { id: string; title: string; questions: LeadFormQuestion[] };

const card = "rounded-xl border border-border bg-card p-4 sm:p-5";
const POLL_MS = 8000;
const POLL_STOP_MS = 15 * 60 * 1000;
const LAST = SHEET_STEPS.length;

function legacyCopy(text: string): boolean {
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(t);
  }, [state]);
  async function copy() {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = legacyCopy(text);
    }
    setState(ok ? "copied" : "failed");
  }
  return (
    <Button type="button" variant="outline" size="sm" className="shrink-0" aria-live="polite" onClick={() => void copy()}>
      {state === "copied" ? "Copied" : state === "failed" ? "Select and copy" : label}
    </Button>
  );
}

function Tick({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <span aria-hidden="true" className={ok ? "font-semibold text-green-600" : "text-muted-foreground"}>{ok ? "✓" : "○"}</span>
      <span className={ok ? "text-foreground" : "text-muted-foreground"}>
        {children}
        <span className="sr-only">{ok ? " (done)" : " (not yet)"}</span>
      </span>
    </li>
  );
}

function Shot({ n, alt, available }: { n: number; alt: string; available: boolean }) {
  const [broken, setBroken] = useState(false);
  return (
    <figure className="mt-5">
      {available && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element -- a fixed screenshot from /public, already cropped to 1200px wide
        <img src={sheetShotUrl(n)} alt={alt} className="w-full rounded-lg border border-border" loading="lazy" onError={() => setBroken(true)} />
      ) : (
        <div className="flex min-h-32 items-center justify-center rounded-lg border border-dashed border-border bg-muted/40 p-4 text-center text-sm text-muted-foreground">Screenshot to come: {alt}</div>
      )}
    </figure>
  );
}

function Alert({ children }: { children: React.ReactNode }) {
  return <p role="alert" className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{children}</p>;
}

function Stuck({ children }: { children: React.ReactNode }) {
  return (
    <details className="mt-5 rounded-lg border border-border p-3">
      <summary className="cursor-pointer text-sm font-medium text-foreground">Stuck?</summary>
      <p className="mt-2 text-sm text-muted-foreground">{children}</p>
    </details>
  );
}

export function ConnectSheet({ forms }: { forms: SheetFormAd[] }) {
  const [status, setStatus] = useState<SheetStatus | null>(null);
  const [shots, setShots] = useState<number[]>([]);
  const [index, setIndex] = useState(0); // 0..5
  const [showSteps, setShowSteps] = useState(false);
  const [adId, setAdId] = useState(forms[0]?.id ?? "");
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const top = useRef<HTMLDivElement>(null);
  const moved = useRef(false);

  // First look (read only). Until it answers, and when the card is not for this viewer, nothing is shown.
  useEffect(() => {
    let live = true;
    void loadSheetCardAction()
      .then((r) => {
        if (!live) return;
        setStatus(r.status);
        setShots(r.shots);
        if (r.status.state === "waiting_test_row") setIndex(4);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  // Step 5 waits for the import to read the test row: ask every few seconds (read only), for at most 15 minutes.
  const waiting = status?.state === "waiting_test_row" && index === 4;
  useEffect(() => {
    if (!waiting) return;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - startedAt > POLL_STOP_MS) {
        clearInterval(timer);
        return;
      }
      void pollSheetAction()
        .then((s) => {
          if (s.available) setStatus(s);
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting]);

  useEffect(() => {
    if (!moved.current) return;
    top.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [index]);

  const [connectState, connect, connecting] = useActionState<SheetState, FormData>(connectSheetAction, {});
  const seenConnect = useRef<SheetState | null>(null);
  useEffect(() => {
    if (connectState === seenConnect.current || (!connectState.ok && !connectState.error)) return;
    seenConnect.current = connectState;
    if (connectState.status) setStatus(connectState.status); // eslint-disable-line react-hooks/set-state-in-effect -- the server's answer, once per press
  }, [connectState]);

  if (!status || !status.available) return null;

  const stuckEmail = status.serviceEmail === null;
  const active = status.mode === "lead_form";
  const i = Math.min(Math.max(index, 0), LAST - 1);
  const step = SHEET_STEPS[i];
  const form = forms.find((f) => f.id === adId) ?? forms[0] ?? null;

  function go(next: number) {
    moved.current = true;
    setIndex(next);
  }

  async function run(fn: () => Promise<SheetState>) {
    setBusy(true);
    setNote(null);
    setProblem(null);
    try {
      const out = await fn();
      if (out.status) setStatus(out.status);
      if (out.error) setProblem(out.error);
      else if (out.notice) setNote(out.notice);
    } catch {
      setProblem("Something went wrong. Please try again soon.");
    } finally {
      setBusy(false);
    }
  }

  const canNext =
    i < LAST - 1 &&
    !(i === 2 && stuckEmail) &&
    !(i === 3 && !(status.shared && status.headersFound)) &&
    !(i === 4 && !status.testRowRead);

  // ── Lead-form mode: the link is active ──
  if (active && !showSteps) {
    const last = SHEET_STEPS[LAST - 1];
    return (
      <section id="lead-forms" className={card} aria-label="Lead forms">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-foreground">Lead forms are on</h2>
          <span className="rounded-full bg-green-600/10 px-2.5 py-0.5 text-xs font-medium text-green-700 dark:text-green-400">Lead-form mode</span>
        </div>
        <ul className="mt-3 space-y-1.5">
          <Tick ok={status.shared}>We can read your sheet</Tick>
          <Tick ok={status.headersFound}>We found the columns we need</Tick>
          <Tick ok={status.testRowRead}>We read your test lead</Tick>
        </ul>
        <div className="mt-5">
          <h3 className="text-lg font-semibold leading-snug text-foreground">{last.action}</h3>
          <p className="mt-2 text-sm text-muted-foreground">{last.detail}</p>
        </div>
        <Shot n={last.n} alt={last.shotAlt} available={shots.includes(last.n)} />
        <Stuck>{last.stuck}</Stuck>
        <div className="mt-5 rounded-lg border border-border bg-muted/40 p-3 text-sm text-foreground">
          <p className="font-medium">What happens to your leads</p>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-muted-foreground">
            <li>Meta adds each lead to your sheet. We read it about once an hour.</li>
            <li>Each new lead appears in your leads list against the ad that brought it, and you get the same new-lead email as for website leads.</li>
            <li>A lead from a form has no report yet, because we only have the details the form asked for.</li>
          </ul>
        </div>
        {problem ? <Alert>{problem}</Alert> : null}
        {note ? <p role="status" className="mt-3 text-sm text-muted-foreground">{note}</p> : null}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <Button type="button" variant="outline" onClick={() => { setShowSteps(true); go(0); }}>Show the setup steps</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => { if (window.confirm("Disconnect your sheet? Your ads go back to your website link. Leads already read stay in your list.")) void run(disconnectSheetAction); }}>
            Disconnect
          </Button>
        </div>
      </section>
    );
  }

  // ── Website mode (or reviewing the steps): the six steps ──
  return (
    <section id="lead-forms" className={card} aria-label="Switch to lead forms">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-foreground">Switch to lead forms</h2>
        <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">{active ? "Lead-form mode" : "Website mode"}</span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Optional. Instead of sending people to your website, your ads can open a Facebook form. Leads land in a Google Sheet you own, and we read it. Until all six steps are done, your ads keep working as they are.
      </p>

      <div ref={top} className="mt-4 scroll-mt-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-foreground">Step {step.n} of {LAST}</p>
          <p className="text-xs text-muted-foreground">{step.title}</p>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={1} aria-valuemax={LAST} aria-valuenow={step.n} aria-label="Lead form setup progress">
          <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round((step.n / LAST) * 100)}%` }} />
        </div>

        <div className="mt-5" aria-live="polite">
          <h3 className="text-xl font-semibold leading-snug text-foreground sm:text-2xl">{step.action}</h3>
          <p className="mt-2 text-sm text-muted-foreground">{step.detail}</p>
        </div>

        {i === 0 && form ? (
          <div className="mt-5">
            {forms.length > 1 ? (
              <>
                <p className="text-xs font-medium text-muted-foreground">Which ad is the form for?</p>
                <div className="mt-1.5 flex flex-wrap gap-2" role="group" aria-label="Choose an ad">
                  {forms.map((f) => (
                    <Button key={f.id} type="button" size="sm" variant={f.id === form.id ? "default" : "outline"} aria-pressed={f.id === form.id} onClick={() => setAdId(f.id)}>{f.title}</Button>
                  ))}
                </div>
              </>
            ) : null}
            <ul className="mt-3 space-y-2">
              {form.questions.map((q) => (
                <li key={`${form.id}-${q.id}`} className="rounded-lg border border-border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-muted-foreground">{q.kind === "choice" ? "Multiple choice question" : "Short answer question"}{q.required ? ", required" : ""}</p>
                      <p className="mt-1 break-words text-sm text-foreground">{q.label}</p>
                    </div>
                    <CopyButton text={q.label} />
                  </div>
                  {q.options && q.options.length > 0 ? (
                    <div className="mt-2 flex items-start justify-between gap-3 border-t border-border pt-2">
                      <ul className="min-w-0 flex-1 list-disc pl-5 text-sm text-muted-foreground">
                        {q.options.map((o) => <li key={o} className="break-words">{o}</li>)}
                      </ul>
                      <CopyButton text={q.options.join("\n")} label="Copy answers" />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {i === 2 ? (
          <div className="mt-5">
            {stuckEmail ? (
              <p role="status" className="rounded-md border border-border bg-muted/40 p-3 text-sm text-foreground">{NOT_AVAILABLE}</p>
            ) : (
              <div className="flex items-start justify-between gap-3 rounded-lg border border-border p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-muted-foreground">Share your sheet with, as a viewer</p>
                  <p className="mt-1 break-all text-sm font-medium text-foreground">{status.serviceEmail}</p>
                </div>
                <CopyButton text={status.serviceEmail ?? ""} />
              </div>
            )}
          </div>
        ) : null}

        {i === 3 ? (
          <form action={connect} className="mt-5">
            <label htmlFor="sheet-link" className="text-xs font-medium text-muted-foreground">Link to your Google Sheet</label>
            <input
              id="sheet-link"
              name="link"
              type="url"
              inputMode="url"
              autoComplete="off"
              placeholder="https://docs.google.com/spreadsheets/d/..."
              disabled={stuckEmail}
              required
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground disabled:opacity-50"
            />
            <div className="mt-3">
              <Button type="submit" disabled={stuckEmail || connecting}>{connecting ? "Checking…" : "Check my sheet"}</Button>
            </div>
            {stuckEmail ? <p role="status" className="mt-3 text-sm text-muted-foreground">{NOT_AVAILABLE}</p> : null}
            {connectState.error ? <Alert>{connectState.error}</Alert> : null}
            <ul className="mt-4 space-y-1.5" aria-label="What we checked">
              <Tick ok={status.shared}>We can open your sheet</Tick>
              <Tick ok={status.headersFound}>We found a name, a phone number or email, and a postcode column</Tick>
            </ul>
            {status.problem ? <Alert>{status.problem}</Alert> : null}
          </form>
        ) : null}

        {i === 4 ? (
          <div className="mt-5">
            <ul className="space-y-1.5" aria-label="What we checked">
              <Tick ok={status.shared}>We can open your sheet</Tick>
              <Tick ok={status.testRowRead}>We read your test lead</Tick>
            </ul>
            {status.problem ? <Alert>{status.problem}</Alert> : null}
            {!status.testRowRead ? (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button type="button" variant="outline" disabled={busy} onClick={() => void run(readSheetNowAction)}>{busy ? "Checking…" : "Check now"}</Button>
                <p className="text-xs text-muted-foreground">We also look every few seconds while this page is open.</p>
              </div>
            ) : (
              <p role="status" className="mt-3 text-sm text-foreground">You are connected. Go on to the last step.</p>
            )}
            {problem ? <Alert>{problem}</Alert> : null}
            {note && !status.testRowRead ? <p role="status" className="mt-3 text-sm text-muted-foreground">{note}</p> : null}
          </div>
        ) : null}

        <Shot n={step.n} alt={step.shotAlt} available={shots.includes(step.n)} />
        <Stuck>{step.stuck}</Stuck>

        <div className="mt-6 flex items-center justify-between gap-3 border-t border-border pt-4">
          <Button type="button" variant="outline" disabled={i === 0} onClick={() => go(i - 1)}>Back</Button>
          {i < LAST - 1 ? (
            <Button type="button" disabled={!canNext} onClick={() => go(i + 1)}>Next</Button>
          ) : active ? (
            <Button type="button" variant="outline" onClick={() => setShowSteps(false)}>Done</Button>
          ) : (
            <Button type="button" variant="outline" disabled>Next</Button>
          )}
        </div>
        {status.state === "waiting_test_row" || active ? (
          <div className="mt-4 text-right">
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { if (window.confirm("Disconnect your sheet? Your ads go back to your website link. Leads already read stay in your list.")) void run(disconnectSheetAction); }}>Disconnect</Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
