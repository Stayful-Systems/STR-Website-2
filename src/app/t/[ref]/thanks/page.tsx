import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { createAdminClient, hasServiceRole } from "@/lib/supabase/admin";
import { parseHexColour, readableOn } from "@/lib/funnels/brand";
import { parseSiteSettings } from "@/lib/websites/store-server";
import { backOrigin, outcomeOf, thanksCopy } from "@/lib/websites/transfer-intake";

/**
 * Batch 37, Phase 6: where an exported website's form sends the visitor,
 * /t/<ref>/thanks?r=<outcome> (the 303 from POST /api/t/<ref>/lead).
 *
 * It speaks in the operator's name and colour, read from the transfer's own
 * snapshot (the site's settings when the snapshot lacks them), so it still
 * reads right after our copy of the site is switched off. It shows nothing
 * about the lead: the address carries an outcome word and nothing else.
 *
 * "Back to <company>" goes to the origin of the Referer, and only when that is
 * an http(s) address. noindex. Never cached: it depends on the address and the
 * Referer.
 */

export const dynamic = "force-dynamic";

const REF = /^[a-z0-9]{16,64}$/;
const FALLBACK_COLOUR = "#1f2937";

export const metadata: Metadata = {
  title: "Thank you",
  robots: { index: false, follow: false },
  icons: { icon: "/icon-neutral.svg" },
};

async function brandOf(ref: string): Promise<{ company: string; colour: string } | null> {
  if (!REF.test(ref) || !hasServiceRole()) return null;
  const admin = createAdminClient();
  const { data: t } = await admin.from("website_transfers").select("website_id, snapshot").eq("ref", ref).maybeSingle();
  if (!t) return null;
  const row = t as { website_id: string; snapshot: unknown };
  const snap = row.snapshot && typeof row.snapshot === "object" && !Array.isArray(row.snapshot) ? (row.snapshot as Record<string, unknown>) : {};
  let company = typeof snap.companyName === "string" ? snap.companyName.trim().slice(0, 80) : "";
  let colour = parseHexColour(snap.brandColour);
  if (!company || !colour) {
    const { data: w } = await admin.from("websites").select("settings").eq("id", row.website_id).maybeSingle();
    const s = parseSiteSettings((w as { settings?: unknown } | null)?.settings);
    company = company || s.companyName;
    colour = colour ?? parseHexColour(s.brandColour);
  }
  return { company, colour: colour ?? FALLBACK_COLOUR };
}

export default async function ExportedFormThanks({ params, searchParams }: { params: Promise<{ ref: string }>; searchParams: Promise<{ r?: string | string[] }> }) {
  const { ref } = await params;
  const { r } = await searchParams;
  const brand = await brandOf(ref);
  if (!brand) notFound();

  const outcome = outcomeOf(r);
  const copy = thanksCopy(outcome, brand.company);
  const origin = backOrigin((await headers()).get("referer"));
  const name = brand.company.trim();

  return (
    <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px 16px", background: "#ffffff", color: "#111827" }}>
      <div style={{ maxWidth: 440, width: "100%", textAlign: "center" }}>
        {name ? <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: brand.colour }}>{name}</p> : null}
        <h1 style={{ margin: "12px 0 0", fontSize: 24, fontWeight: 600 }}>{copy.heading}</h1>
        <p style={{ margin: "12px 0 0", fontSize: 16, lineHeight: 1.5, color: "#475569" }}>{copy.body}</p>
        {origin ? (
          <p style={{ margin: "28px 0 0" }}>
            <a
              href={origin}
              style={{ display: "inline-block", padding: "10px 20px", borderRadius: 8, background: brand.colour, color: readableOn(brand.colour), fontSize: 15, fontWeight: 600, textDecoration: "none" }}
            >
              Back to {name || "the site"}
            </a>
          </p>
        ) : null}
      </div>
    </main>
  );
}
