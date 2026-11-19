"use client";

import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { TurnstileWidget, resetTurnstile } from "@/components/TurnstileWidget";
import { splitAddressAndPostcode } from "@/components/AddressAutocomplete";
import type { LeadFormProps } from "./lead-form-props";
import type { ReportSummary } from "./summary";

/**
 * Batch 31: the landlord form on a customer's website. Two steps.
 *
 *   Step 1  name, email, phone and the consent tick (the exact consentText the
 *           page model built). POST <form.action> (/api/s/<slug>/lead). The
 *           lead is saved there, whether or not step 2 ever happens. The
 *           answer's step token is kept in this component's state and nowhere
 *           else.
 *   Step 2  the property: address (with autocomplete), postcode, bedrooms,
 *           guests. POST /api/s/<slug>/report with the token in the body. The
 *           answer is a stream: progress text, then one final event with the
 *           outcome (headline estimate, "within 24 hours", or "<Company> will
 *           be in touch").
 *
 * Privacy, all deliberate:
 *   - nothing here touches localStorage, sessionStorage, IndexedDB or cookies;
 *   - the address and the token are only ever in a POST body and in component
 *     state: never in a URL, never in console output;
 *   - attribution (utm_*, fbclid, ad, landing path) is read ONCE from the page
 *     address by AttributionProvider, which the site's layout mounts, and held
 *     in a React context for every page's form. A landlord who reads three
 *     pages before enquiring still carries the tags they arrived with.
 *
 * Turnstile is the funnel's own widget (components/TurnstileWidget.tsx).
 */

// ── Attribution, held at layout level ──

/** What a lead's source row is made of: tag values and the landing path (a path only). */
export interface Attribution {
  sources: Record<string, string>;
  landing: string | null;
}

const EMPTY_ATTRIBUTION: Attribution = { sources: {}, landing: null };

/** The attribution tags the server reads, nothing else is ever forwarded. */
const SOURCE_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "ad"] as const;
/** Matches sources.ts: the ad code is at most 40 characters. */
const AD_MAX = 40;
const TAG_MAX = 200;

function readAttribution(): Attribution {
  if (typeof window === "undefined") return EMPTY_ATTRIBUTION;
  const query = new URLSearchParams(window.location.search);
  const sources: Record<string, string> = {};
  for (const key of SOURCE_KEYS) {
    const raw = query.get(key);
    if (!raw) continue;
    const v = raw.trim().slice(0, key === "ad" ? AD_MAX : TAG_MAX);
    if (v) sources[key] = v;
  }
  // The path only: the query string (and with it any tag) never rides along as the landing page.
  return { sources, landing: window.location.pathname || null };
}

interface AttributionApi {
  read: () => Attribution;
}

const AttributionContext = createContext<AttributionApi>({ read: () => EMPTY_ATTRIBUTION });

/**
 * Mount once in the site's layout. Layouts stay mounted as the visitor moves
 * between the site's pages, so what the first page's address carried is what
 * every page's form sends. Read in an effect (the address is not known on the
 * server) into a ref: it is read at submit time, so it needs no re-render.
 */
export function AttributionProvider({ children }: { children: ReactNode }) {
  const held = useRef<Attribution>(EMPTY_ATTRIBUTION);
  const [api] = useState<AttributionApi>(() => ({ read: () => held.current }));
  useEffect(() => {
    held.current = readAttribution();
  }, []);
  return <AttributionContext.Provider value={api}>{children}</AttributionContext.Provider>;
}

// ── The form ──

export interface LeadFormComponentProps extends LeadFormProps {
  /** The owner's preview: the form is drawn but sends nothing. */
  preview?: boolean;
}

interface FieldError {
  field: string;
  message: string;
}

interface Suggestion {
  placeId: string;
  description: string;
  mainText: string;
  secondaryText: string;
}

type Outcome = "summary" | "summary_caveat" | "held" | "will_contact";

interface Done {
  outcome: Outcome;
  message: string;
  summary: ReportSummary | null;
}

const BEDROOM_OPTIONS = Array.from({ length: 11 }, (_, i) => i);
const GUEST_OPTIONS = Array.from({ length: 16 }, (_, i) => i + 1);
const MIN_AUTOCOMPLETE = 3;

const inputClass =
  "mt-1 block w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary disabled:opacity-60";
const labelClass = "block text-sm font-medium text-foreground";
const errorClass = "mt-1 text-sm text-red-700";
const buttonClass =
  "inline-flex w-full items-center justify-center rounded-lg bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow-sm hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60";

const GENERIC_ERROR = "Something went wrong. Please try again.";

/** "/api/s/<slug>/lead" gives the site's api base and its slug, so nothing here spells the site's address. */
function apiBaseOf(action: string): { base: string; slug: string } {
  const base = action.replace(/\/lead\/?$/, "");
  const slug = decodeURIComponent(base.split("/").filter(Boolean).pop() ?? "");
  return { base, slug };
}

const gbp = (n: number) => `£${Math.round(n).toLocaleString("en-GB")}`;

function parseFieldErrors(v: unknown): FieldError[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((e) => (e && typeof e === "object" ? (e as Record<string, unknown>) : null))
    .filter((e): e is Record<string, unknown> => e !== null && typeof e.message === "string")
    .map((e) => ({ field: typeof e.field === "string" ? e.field : "", message: String(e.message) }));
}

export function LeadForm({ form, companyName, heading, intro, anchorId, preview = false }: LeadFormComponentProps) {
  const attribution = useContext(AttributionContext);
  const { base: apiBase, slug } = apiBaseOf(form.action);
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;
  const company = companyName.trim() || "We";

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);

  // Step 1.
  const [values, setValues] = useState<Record<string, string>>({ name: "", email: "", phone: "" });
  const [consent, setConsent] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);

  // The step token lives here and nowhere else: not a URL, a cookie or storage.
  const [stepToken, setStepToken] = useState<string | null>(null);

  // Step 2.
  const [address, setAddress] = useState("");
  const [postcode, setPostcode] = useState("");
  const [bedrooms, setBedrooms] = useState("");
  const [guests, setGuests] = useState("");
  const [found, setSuggestions] = useState<Suggestion[]>([]);
  const [listOpen, setListOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [progressText, setProgressText] = useState("");
  const [progressPct, setProgressPct] = useState(0);

  const [done, setDone] = useState<Done | null>(null);

  // One autocomplete session id per mounted form (Google bills a typing session once).
  const sessionRef = useRef<string | null>(null);
  const suppressLookup = useRef(false);

  // Too short to look up means nothing to show, whatever an earlier lookup left behind.
  const suggestions = address.trim().length >= MIN_AUTOCOMPLETE ? found : [];

  const errorFor = (field: string) => fieldErrors.find((e) => e.field === field)?.message ?? null;
  const looseErrors = fieldErrors.filter((e) => !["name", "email", "phone", "consent"].includes(e.field));

  // Address suggestions, debounced. A failed or refused lookup is silent: the address can be typed.
  useEffect(() => {
    if (step !== 2 || preview) return;
    if (suppressLookup.current) {
      suppressLookup.current = false;
      return;
    }
    const q = address.trim();
    if (q.length < MIN_AUTOCOMPLETE) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      sessionRef.current ??=
        typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const url = `/api/address-autocomplete?q=${encodeURIComponent(q)}&session=${encodeURIComponent(sessionRef.current)}&s=${encodeURIComponent(slug)}`;
      fetch(url, { signal: controller.signal })
        .then((res) => res.json())
        .then((data: { suggestions?: Suggestion[] }) => {
          const list = Array.isArray(data.suggestions) ? data.suggestions : [];
          setSuggestions(list);
          setHighlight(-1);
        })
        .catch(() => {
          if (!controller.signal.aborted) setSuggestions([]);
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [address, step, preview, slug]);

  const choose = (s: Suggestion) => {
    const parts = splitAddressAndPostcode(s.description);
    suppressLookup.current = true;
    setAddress(parts.address);
    if (parts.postcode) setPostcode(parts.postcode);
    setSuggestions([]);
    setListOpen(false);
    setHighlight(-1);
  };

  const onAddressKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!listOpen || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      setHighlight((h) => Math.min(h + 1, suggestions.length - 1));
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      setHighlight((h) => Math.max(h - 1, 0));
      e.preventDefault();
    } else if (e.key === "Enter" && highlight >= 0 && highlight < suggestions.length) {
      choose(suggestions[highlight]);
      e.preventDefault();
    } else if (e.key === "Escape") {
      setListOpen(false);
    }
  };

  // ── Step 1 ──
  async function submitStepOne(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setFormError(null);
    setFieldErrors([]);
    if (preview) {
      setFormError("This is a preview. The form sends nothing.");
      return;
    }
    setBusy(true);
    try {
      const { sources, landing } = attribution.read();
      const res = await fetch(form.action, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: values.name,
          email: values.email,
          phone: values.phone,
          consent,
          turnstileToken,
          sources,
          landing,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; token?: string | null; error?: string; errors?: unknown };
      if (!res.ok || data.ok !== true) {
        const errs = parseFieldErrors(data.errors);
        if (errs.length) setFieldErrors(errs);
        else setFormError(typeof data.error === "string" && data.error ? data.error : GENERIC_ERROR);
        // A Turnstile token is single use: whatever failed, the next try needs a fresh one.
        setTurnstileToken(null);
        resetTurnstile();
        return;
      }
      if (typeof data.token === "string" && data.token) {
        setStepToken(data.token);
        setStep(2);
      } else {
        // The enquiry was already saved and has moved on: nothing more to ask, nothing to reveal.
        setDone({ outcome: "will_contact", message: `${company} will be in touch.`, summary: null });
        setStep(3);
      }
    } catch {
      setFormError(GENERIC_ERROR);
      setTurnstileToken(null);
      resetTurnstile();
    } finally {
      setBusy(false);
    }
  }

  // ── Step 2 ──
  async function submitStepTwo(e: FormEvent) {
    e.preventDefault();
    if (busy || !stepToken) return;
    setFormError(null);
    setFieldErrors([]);
    if (address.trim().length < 3) {
      setFieldErrors([{ field: "address", message: "Please enter the property address." }]);
      return;
    }
    if (postcode.trim().length < 3) {
      setFieldErrors([{ field: "postcode", message: "Please enter the property postcode." }]);
      return;
    }
    if (bedrooms === "" || guests === "") {
      setFieldErrors([
        ...(bedrooms === "" ? [{ field: "bedrooms", message: "Please choose the number of bedrooms." }] : []),
        ...(guests === "" ? [{ field: "guests", message: "Please choose how many guests it sleeps." }] : []),
      ]);
      return;
    }

    setBusy(true);
    setProgressText("Starting your estimate");
    setProgressPct(0);
    try {
      const res = await fetch(`${apiBase}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: stepToken,
          address: address.trim(),
          postcode: postcode.trim(),
          bedrooms: Number(bedrooms),
          guests: Number(guests),
        }),
      });
      if (!res.body) {
        setFormError(GENERIC_ERROR);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;

      const handle = (line: string): boolean => {
        if (!line.startsWith("data: ")) return false;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line.slice(6)) as Record<string, unknown>;
        } catch {
          return false;
        }
        if (event.stage === "error") {
          setFormError(typeof event.message === "string" && event.message ? event.message : GENERIC_ERROR);
          return true;
        }
        if (event.stage === "complete") {
          const outcome = event.outcome as Outcome;
          const summary = (event.summary ?? null) as ReportSummary | null;
          const message = typeof event.message === "string" ? event.message : "";
          if (outcome === "summary" || outcome === "summary_caveat") {
            if (summary && summary.figures) {
              setDone({ outcome, message, summary });
              setStep(3);
              return true;
            }
            setDone({ outcome: "will_contact", message: `${company} will be in touch.`, summary: null });
            setStep(3);
            return true;
          }
          if (outcome === "held") {
            setDone({ outcome, message: `${company} is very busy at the moment. Your estimate will reach you within 24 hours.`, summary: null });
            setStep(3);
            return true;
          }
          setDone({ outcome: "will_contact", message: message || `${company} will be in touch.`, summary: null });
          setStep(3);
          return true;
        }
        if (typeof event.message === "string" && event.message) setProgressText(event.message);
        if (typeof event.progress === "number") setProgressPct(Math.max(0, Math.min(100, event.progress)));
        return false;
      };

      while (!finished) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (handle(line)) {
            finished = true;
            break;
          }
        }
      }
      if (!finished && buffer) finished = handle(buffer);
      if (!finished) {
        // The stream ended without an outcome. The lead is saved, so this is not a lost enquiry.
        setDone({ outcome: "will_contact", message: `${company} will be in touch.`, summary: null });
        setStep(3);
      }
    } catch {
      setFormError(GENERIC_ERROR);
    } finally {
      setBusy(false);
    }
  }

  // ── Drawing ──
  const headingBlock = (
    <>
      <h2 id={anchorId} className="text-xl font-semibold text-foreground">
        {heading}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{intro}</p>
    </>
  );

  if (step === 3 && done) {
    return (
      <div aria-live="polite">
        <h2 id={anchorId} className="text-xl font-semibold text-foreground">
          {done.summary ? "Estimate" : "Thank you"}
        </h2>
        {done.summary ? (
          <Summary summary={done.summary} companyName={company} />
        ) : (
          <p className="mt-3 text-foreground">{done.message}</p>
        )}
      </div>
    );
  }

  if (step === 2) {
    const busyNow = busy;
    return (
      <div>
        {headingBlock}
        <form onSubmit={submitStepTwo} className="mt-4 space-y-4" noValidate aria-busy={busyNow}>
          <p className="text-sm text-muted-foreground">Step 2 of 2: the property</p>

          <div className="relative">
            <label htmlFor={id("address")} className={labelClass}>
              Property address
            </label>
            <input
              id={id("address")}
              type="text"
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                setListOpen(true);
                setHighlight(-1);
              }}
              onFocus={() => setListOpen(true)}
              onBlur={() => setListOpen(false)}
              onKeyDown={onAddressKey}
              autoComplete="off"
              maxLength={200}
              disabled={busyNow}
              role="combobox"
              aria-expanded={listOpen && suggestions.length > 0}
              aria-autocomplete="list"
              aria-controls={id("suggestions")}
              placeholder="Start typing the address"
              className={inputClass}
            />
            {listOpen && suggestions.length > 0 ? (
              <ul id={id("suggestions")} role="listbox" className="absolute left-0 right-0 z-20 mt-1 max-h-72 overflow-auto rounded-lg border border-border bg-background shadow-lg">
                {suggestions.map((s, i) => (
                  <li
                    key={s.placeId}
                    role="option"
                    aria-selected={i === highlight}
                    onMouseEnter={() => setHighlight(i)}
                    // mousedown, so the choice lands before the input's blur closes the list.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      choose(s);
                    }}
                    className={`cursor-pointer px-3 py-2 text-sm ${i === highlight ? "bg-muted" : ""}`}
                  >
                    <p className="truncate font-medium text-foreground">{s.mainText || s.description}</p>
                    {s.secondaryText ? <p className="truncate text-xs text-muted-foreground">{s.secondaryText}</p> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {errorFor("address") ? (
              <p role="alert" className={errorClass}>
                {errorFor("address")}
              </p>
            ) : null}
          </div>

          <div>
            <label htmlFor={id("postcode")} className={labelClass}>
              Postcode
            </label>
            <input
              id={id("postcode")}
              type="text"
              value={postcode}
              onChange={(e) => setPostcode(e.target.value)}
              autoComplete="postal-code"
              maxLength={10}
              disabled={busyNow}
              className={inputClass}
            />
            {errorFor("postcode") ? (
              <p role="alert" className={errorClass}>
                {errorFor("postcode")}
              </p>
            ) : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor={id("bedrooms")} className={labelClass}>
                Bedrooms
              </label>
              <select id={id("bedrooms")} value={bedrooms} onChange={(e) => setBedrooms(e.target.value)} disabled={busyNow} className={inputClass}>
                <option value="">Choose</option>
                {BEDROOM_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? "Studio" : n}
                  </option>
                ))}
              </select>
              {errorFor("bedrooms") ? (
                <p role="alert" className={errorClass}>
                  {errorFor("bedrooms")}
                </p>
              ) : null}
            </div>
            <div>
              <label htmlFor={id("guests")} className={labelClass}>
                Sleeps (guests)
              </label>
              <select id={id("guests")} value={guests} onChange={(e) => setGuests(e.target.value)} disabled={busyNow} className={inputClass}>
                <option value="">Choose</option>
                {GUEST_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              {errorFor("guests") ? (
                <p role="alert" className={errorClass}>
                  {errorFor("guests")}
                </p>
              ) : null}
            </div>
          </div>

          {looseErrors.length ? (
            <p role="alert" className={errorClass}>
              {looseErrors.map((e) => e.message).join(" ")}
            </p>
          ) : null}
          {formError ? (
            <p role="alert" className={errorClass}>
              {formError}
            </p>
          ) : null}

          {busyNow ? (
            <div aria-live="polite" className="space-y-2">
              <p className="text-sm text-foreground">{progressText}</p>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPct}>
                <div className="h-full bg-primary transition-all" style={{ width: `${progressPct}%` }} />
              </div>
            </div>
          ) : null}

          <button type="submit" disabled={busyNow} className={buttonClass}>
            {busyNow ? "Preparing your estimate" : "Show my estimate"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div>
      {headingBlock}
      <form onSubmit={submitStepOne} className="mt-4 space-y-4" noValidate aria-busy={busy}>
        <p className="text-sm text-muted-foreground">Step 1 of 2: your details</p>

        {form.fields.map((f) => (
          <div key={f.name}>
            <label htmlFor={id(f.name)} className={labelClass}>
              {f.label}
            </label>
            <input
              id={id(f.name)}
              name={f.name}
              type={f.type}
              autoComplete={f.autocomplete}
              maxLength={f.maxLength}
              required={f.required}
              value={values[f.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              disabled={busy}
              aria-invalid={errorFor(f.name) ? true : undefined}
              className={inputClass}
            />
            {errorFor(f.name) ? (
              <p role="alert" className={errorClass}>
                {errorFor(f.name)}
              </p>
            ) : null}
          </div>
        ))}

        <div>
          <label className="flex items-start gap-3 text-sm text-foreground">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              disabled={busy}
              required
              aria-invalid={errorFor(form.consentField) ? true : undefined}
              className="mt-1 h-4 w-4 shrink-0 rounded border-input accent-primary"
            />
            <span>{form.consentText}</span>
          </label>
          <p className="mt-1 text-xs text-muted-foreground">
            <a href={form.privacyHref} className="underline underline-offset-2">
              Privacy &amp; Terms
            </a>
          </p>
          {errorFor(form.consentField) ? (
            <p role="alert" className={errorClass}>
              {errorFor(form.consentField)}
            </p>
          ) : null}
        </div>

        <TurnstileWidget siteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null} onToken={setTurnstileToken} theme="light" />

        {looseErrors.length ? (
          <p role="alert" className={errorClass}>
            {looseErrors.map((e) => e.message).join(" ")}
          </p>
        ) : null}
        {formError ? (
          <p role="alert" className={errorClass}>
            {formError}
          </p>
        ) : null}

        <button type="submit" disabled={busy} className={buttonClass}>
          {busy ? "Saving" : form.submitLabel}
        </button>
        {preview ? <p className="text-xs text-muted-foreground">Preview: this form sends nothing.</p> : null}
      </form>
    </div>
  );
}

/** The headline estimate. Labelled an estimate, gross, never a promise. */
function Summary({ summary, companyName }: { summary: ReportSummary; companyName: string }) {
  const f = summary.figures;
  const labels = summary.figureLabels;
  const rows: { label: string; value: string }[] = [
    { label: labels.monthlyIncome, value: gbp(f.monthlyIncome) },
    { label: labels.annualIncome, value: gbp(f.annualIncome) },
    { label: labels.occupancyPct, value: `${Math.round(f.occupancyPct)}%` },
    { label: labels.nightlyRate, value: gbp(f.nightlyRate) },
  ];
  return (
    <div className="mt-3 space-y-4">
      <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{summary.label}</p>
      {summary.caveat ? <p className="rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground">Please note: {summary.caveat}.</p> : null}
      <dl className="grid gap-3 sm:grid-cols-2">
        {rows.map((r) => (
          <div key={r.label} className="rounded-lg border border-border bg-background p-4">
            <dt className="text-xs text-muted-foreground">{r.label}</dt>
            <dd className="mt-1 text-2xl font-semibold text-foreground">{r.value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm text-muted-foreground">These figures are an estimate of gross income, not a promise of what a property will earn. {companyName} will be in touch to talk it through.</p>
    </div>
  );
}
