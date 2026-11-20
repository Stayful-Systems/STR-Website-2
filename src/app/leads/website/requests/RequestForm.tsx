"use client";

import { useActionState, useRef, useState } from "react";
import { sendRequestAction, type RequestFormState } from "./request-actions";
import { ErrorLine, field, labelCls, primaryBtn } from "../../setup/ui";

const INITIAL: RequestFormState = {};
const MAX = 2000;
/** Next caps a form post at 1 MB, text included: a screenshot over this is told so here, before it is sent. */
const CLIENT_SCREENSHOT_MAX = 900 * 1024;

/**
 * Batch 36 (Phase 5): ask us for a change. A text box (up to 2000 characters)
 * and an optional PNG or JPEG screenshot. Nothing but those two is posted:
 * the website is the signed-in owner's own (request-actions.ts).
 */
export function RequestForm() {
  const [state, action, pending] = useActionState(sendRequestAction, INITIAL);
  const [text, setText] = useState("");
  const [fileNote, setFileNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f && f.size >= CLIENT_SCREENSHOT_MAX) {
      e.target.value = "";
      setFileNote("That screenshot is over 900 KB. Please use a smaller one, or send the request without it.");
    } else setFileNote(null);
  }

  if (state.sent) {
    return (
      <div role="status" className="rounded-lg border border-border p-4 text-sm text-foreground">
        <p className="font-medium">Thanks, we have your request.</p>
        <p className="mt-1 text-muted-foreground">We will email you when it is done. You can send another below.</p>
        {state.screenshotMessage ? <p className="mt-2 text-muted-foreground">{state.screenshotMessage}</p> : null}
        <button type="button" onClick={() => window.location.reload()} className="mt-3 text-sm font-medium underline underline-offset-2">
          Send another request
        </button>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-3 rounded-lg border border-border p-4">
      <div>
        <label htmlFor="request-body" className={labelCls}>What would you like changed?</label>
        <textarea id="request-body" name="body" rows={6} maxLength={MAX} required value={text} onChange={(e) => setText(e.target.value)} className={field} disabled={pending} />
        <p className="mt-1 text-xs text-muted-foreground">{text.length} / {MAX}</p>
      </div>
      <div>
        <label htmlFor="request-shot" className={labelCls}>A screenshot (optional)</label>
        <input id="request-shot" ref={fileRef} type="file" name="screenshot" accept="image/png,image/jpeg" onChange={onFile} disabled={pending} className="mt-1 block w-full text-sm" />
        <p className="mt-1 text-xs text-muted-foreground">PNG or JPEG, under 900 KB. Only we can see it. Please don&rsquo;t include landlords&rsquo; personal details.</p>
        {fileNote ? <p className="mt-1 text-xs text-destructive">{fileNote}</p> : null}
      </div>
      <ErrorLine state={state} />
      <button type="submit" disabled={pending || !text.trim()} className={primaryBtn}>
        {pending ? "Sending…" : "Send request"}
      </button>
    </form>
  );
}
