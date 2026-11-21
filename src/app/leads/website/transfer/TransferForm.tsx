"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { OTHER_PROVIDER_KEY, TRANSFER_PROVIDERS } from "@/lib/websites/transfer-providers";
import {
  checkTransferAction,
  downloadLinkAction,
  resendCodeAction,
  startTransferAction,
  type CodeState,
  type LinkState,
  type TransferFormState,
  type TransferView,
} from "./transfer-actions";
import { ErrorLine, field, labelCls, primaryBtn } from "../../setup/ui";

const INITIAL: TransferFormState = {};
const secondaryBtn = "inline-flex min-h-10 items-center rounded-md border border-border bg-background px-4 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50";

const WHEN = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" });
const dayText = (iso: string | null): string => {
  const d = iso ? new Date(iso) : null;
  return d && Number.isFinite(d.getTime()) ? WHEN.format(d) : "the date we emailed you";
};

/**
 * Batch 37 (Phase 8): start taking the website. Pick where the domain is registered now, press Check
 * (a dry run: it writes and sends nothing and shows what would happen, or why not), then Confirm.
 * Only the provider and, for "Other", its tag are posted. The website is the signed-in owner's own.
 */
export function TransferForm({ hasDomain }: { hasDomain: boolean }) {
  const router = useRouter();
  const [providerKey, setProviderKey] = useState<string>(hasDomain ? "" : "none");
  const [tag, setTag] = useState("");
  const [checkedFor, setCheckedFor] = useState<string | null>(null);
  const current = `${providerKey}|${providerKey === OTHER_PROVIDER_KEY ? tag.trim().toUpperCase() : ""}`;

  const [check, checkAction, checking] = useActionState(async (prev: TransferFormState, fd: FormData) => {
    const res = await checkTransferAction(prev, fd);
    setCheckedFor(`${String(fd.get("providerKey") ?? "")}|${String(fd.get("providerKey")) === OTHER_PROVIDER_KEY ? String(fd.get("tag") ?? "").trim().toUpperCase() : ""}`);
    return res;
  }, INITIAL);
  const [start, startAction, starting] = useActionState(startTransferAction, INITIAL);

  useEffect(() => {
    if (start.started) router.refresh();
  }, [start.started, router]);

  const confirming = Boolean(check.plan) && checkedFor === current;
  const canCheck = !hasDomain || (providerKey !== "" && (providerKey !== OTHER_PROVIDER_KEY || tag.trim() !== ""));

  return (
    <div className="space-y-5">
      <form action={checkAction} className="space-y-4 rounded-lg border border-border p-4">
        {hasDomain ? (
          <fieldset className="space-y-2">
            <legend className={labelCls}>Where is your domain registered now?</legend>
            <p className="text-xs text-muted-foreground">This is the company your domain moves to. Pick the one you want it moved to.</p>
            {TRANSFER_PROVIDERS.map((p) => (
              <label key={p.key} className="flex min-h-10 items-center gap-3 rounded-md border border-border px-3 text-sm text-foreground">
                <input type="radio" name="providerKey" value={p.key} checked={providerKey === p.key} onChange={() => setProviderKey(p.key)} disabled={checking || starting} />
                <span>
                  {p.name} <span className="text-muted-foreground">(tag {p.tag})</span>
                </span>
              </label>
            ))}
            <label className="flex min-h-10 items-center gap-3 rounded-md border border-border px-3 text-sm text-foreground">
              <input type="radio" name="providerKey" value={OTHER_PROVIDER_KEY} checked={providerKey === OTHER_PROVIDER_KEY} onChange={() => setProviderKey(OTHER_PROVIDER_KEY)} disabled={checking || starting} />
              <span>Other: type its tag</span>
            </label>
            {providerKey === OTHER_PROVIDER_KEY ? (
              <div>
                <label htmlFor="transfer-tag" className={labelCls}>Its tag</label>
                <input id="transfer-tag" name="tag" value={tag} onChange={(e) => setTag(e.target.value)} maxLength={31} autoComplete="off" spellCheck={false} className={field} disabled={checking || starting} />
                <p className="mt-1 text-xs text-muted-foreground">The company you are moving to will tell you this. Letters, numbers and hyphens only.</p>
              </div>
            ) : null}
          </fieldset>
        ) : (
          <p className="text-sm text-muted-foreground">You do not have a domain with us, so there is nothing to move. We will send you your website files.</p>
        )}
        <ErrorLine state={check} />
        <button type="submit" disabled={checking || starting || !canCheck} className={primaryBtn}>
          {checking ? "Checking…" : "Check"}
        </button>
        <p className="text-xs text-muted-foreground">Checking changes nothing. You confirm on the next step.</p>
      </form>

      {confirming ? (
        <form action={startAction} className="space-y-3 rounded-lg border border-border bg-card p-4" aria-live="polite">
          <p className="text-sm font-medium text-foreground">If you confirm, this is what happens</p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {check.plan?.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <input type="hidden" name="providerKey" value={providerKey === "none" ? "" : providerKey} />
          <input type="hidden" name="tag" value={providerKey === OTHER_PROVIDER_KEY ? tag : ""} />
          <ErrorLine state={start} />
          <button type="submit" disabled={starting} className={primaryBtn}>
            {starting ? "Starting…" : "Confirm and take my website"}
          </button>
        </form>
      ) : null}
    </div>
  );
}

const DOMAIN_LINE: Record<string, string> = {
  none: "You have no domain with us, so only your files are being sent.",
  pending: "We are about to ask for your domain to move.",
  manual: "Our team is finishing the domain move by hand. We will email you when it is done.",
  requested: "The move has been asked for and is waiting on the company you are moving to.",
  moved: "Your domain has moved.",
};

/** After starting: the files, the domain, when our copy stops, and the code again. */
export function TransferStatus({ view, overlapDays }: { view: TransferView; overlapDays: number }) {
  const [link, linkAction, linking] = useActionState(async (): Promise<LinkState> => downloadLinkAction(), {} as LinkState);
  const [code, codeAction, sending] = useActionState(async (): Promise<CodeState> => resendCodeAction(), {} as CodeState);
  const domainLine =
    view.domain === "requested" && view.method === "code"
      ? `We emailed you a transfer code for ${view.domainName ?? "your domain"}. Give it to ${view.providerName} to start the move.`
      : view.domain === "requested" && view.method === "tag"
        ? `We have asked for ${view.domainName ?? "your domain"} to move to ${view.providerName}. It is waiting on them.`
        : (DOMAIN_LINE[view.domain] ?? DOMAIN_LINE.none);

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-border p-4 text-sm" aria-labelledby="t-files">
        <h2 id="t-files" className="font-medium text-foreground">Your website files</h2>
        {view.files === "ready" ? (
          <>
            <p className="mt-1 text-muted-foreground">Your files and guide are ready, and we have emailed them to you. You can also download them here.</p>
            {!view.overlapEnded ? (
              <form action={linkAction} className="mt-3 space-y-2">
                <button type="submit" disabled={linking} className={secondaryBtn}>{linking ? "Getting your link…" : "Get my download link"}</button>
                {link.url ? (
                  <p role="status" className="text-foreground">
                    <a href={link.url} className="font-medium underline underline-offset-2" rel="noreferrer">Download my files</a>
                    <span className="text-muted-foreground"> (this link works for 10 minutes; press the button again for a new one)</span>
                  </p>
                ) : null}
                {link.error ? <p role="alert" className="text-destructive">{link.error}</p> : null}
              </form>
            ) : null}
          </>
        ) : view.files === "failed" ? (
          <p className="mt-1 text-muted-foreground">Something went wrong building your files. Our team has been told and will email you.</p>
        ) : (
          <p className="mt-1 text-muted-foreground">We are building your files. We will email them to you as soon as they are ready.</p>
        )}
      </section>

      <section className="rounded-lg border border-border p-4 text-sm" aria-labelledby="t-domain">
        <h2 id="t-domain" className="font-medium text-foreground">Your domain</h2>
        <p className="mt-1 text-muted-foreground">{domainLine}</p>
        {view.method === "code" && view.domain === "requested" && !view.overlapEnded ? (
          <form action={codeAction} className="mt-3 space-y-2">
            <button type="submit" disabled={sending} className={secondaryBtn}>{sending ? "Sending…" : "Email me the code again"}</button>
            {code.sent ? <p role="status" className="text-foreground">Done. Check your inbox in a minute or two.</p> : null}
            {code.error ? <p role="alert" className="text-destructive">{code.error}</p> : null}
          </form>
        ) : null}
      </section>

      <section className="rounded-lg border border-border p-4 text-sm" aria-labelledby="t-overlap">
        <h2 id="t-overlap" className="font-medium text-foreground">Our copy of your website</h2>
        {view.overlapEnded ? (
          <p className="mt-1 text-muted-foreground">Our copy of your website has stopped. Your own copy, from the files we sent, carries on.</p>
        ) : (
          <p className="mt-1 text-muted-foreground">
            We keep our copy running for {overlapDays} days so nothing breaks while you move it. It stops on {dayText(view.overlapEndsAt)}
            {view.domain === "pending" || view.domain === "manual" || view.domain === "requested" ? ", or once your domain has moved if that is later" : ""}.
          </p>
        )}
        <p className="mt-2 text-muted-foreground">The enquiry form in your files keeps sending leads to your account, with or without a plan.</p>
      </section>
    </div>
  );
}
