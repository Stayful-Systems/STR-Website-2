"use client";

import { useState } from "react";

/**
 * Batch 31a: "Buy the Academy" → POST /api/billing/academy/checkout → Stripe
 * Checkout. Signed in or not; shows the route's message if it cannot open.
 */
export function BuyButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function buy() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/academy/checkout", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (res.ok && body.url) {
        window.location.assign(body.url);
        return;
      }
      setError(body.error ?? "Couldn't start checkout. Please try again.");
    } catch {
      setError("Couldn't start checkout. Please try again.");
    }
    setBusy(false);
  }

  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={buy}
        disabled={busy}
        className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60"
      >
        {busy ? "Opening checkout…" : "Buy the Academy"}
      </button>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
