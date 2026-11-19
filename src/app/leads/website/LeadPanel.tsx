import Link from "next/link";
import { createAdminClient, hasServiceRole } from "@/lib/supabase/admin";
import { reportStateText, websiteCardModel, type WebsiteCardInput } from "@/lib/websites/lead-panel";

/**
 * Batch 31 phase 12: what a website lead adds to the lead view.
 *
 * Server component. It is rendered by the lead page only after that page has
 * resolved the signed-in member's scope and found the lead under the owner's
 * id, so a lead id from another account never reaches it (that page 404s).
 * It reads website_reports and lead_sources for that one lead through the
 * service role, and only the columns listed below: never `leads.result`, an
 * address, or a postcode. Renders nothing for a lead with no website report
 * row, so an ordinary funnel lead looks exactly as before.
 */

const REPORT_COLUMNS = "state, due_day, quality_ok, self_submit";
const SOURCE_COLUMNS = "utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, ad_code, landing_page";

interface ReportRow {
  state: string;
  due_day: string | null;
  quality_ok: boolean | null;
  self_submit: boolean;
}

interface SourceRow {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  fbclid: string | null;
  ad_code: string | null;
  landing_page: string | null;
}

const SOURCE_LABELS: [keyof SourceRow, string][] = [
  ["utm_source", "Source"],
  ["utm_medium", "Medium"],
  ["utm_campaign", "Campaign"],
  ["utm_content", "Content"],
  ["utm_term", "Term"],
  ["fbclid", "Facebook click id"],
  ["ad_code", "Ad code"],
  ["landing_page", "Landing page"],
];

const TONE: Record<string, string> = {
  ok: "text-success",
  warn: "text-warning",
  bad: "text-destructive",
  neutral: "text-foreground",
};

export async function LeadPanel({ leadId }: { leadId: string }) {
  if (!hasServiceRole()) return null;
  const db = createAdminClient();
  const [reportRes, sourceRes] = await Promise.all([
    db.from("website_reports").select(REPORT_COLUMNS).eq("lead_id", leadId).maybeSingle(),
    db.from("lead_sources").select(SOURCE_COLUMNS).eq("lead_id", leadId).maybeSingle(),
  ]);
  const report = reportRes.data as unknown as ReportRow | null;
  if (!report) return null;
  const source = sourceRes.data as unknown as SourceRow | null;

  const text = reportStateText({ state: report.state, dueDay: report.due_day, qualityOk: report.quality_ok });
  const sourceRows = source ? SOURCE_LABELS.filter(([key]) => Boolean(source[key])) : [];

  return (
    <section className="mt-3 rounded-xl border border-border bg-card p-4 sm:p-5" aria-label="Website enquiry">
      <h2 className="text-sm font-semibold text-foreground">From your website</h2>
      <p className={`mt-2 text-sm font-medium ${TONE[text.tone]}`}>Report: {text.label}</p>
      {text.detail ? <p className="mt-1 text-xs text-muted-foreground">{text.detail}</p> : null}
      {report.self_submit ? (
        <p className="mt-2 text-xs text-warning">Flagged as a self-submit: it matches your own or your team&apos;s details.</p>
      ) : null}

      <div className="mt-3 border-t border-border pt-3">
        <p className="text-xs font-medium text-foreground">Where they came from</p>
        {sourceRows.length > 0 && source ? (
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            {sourceRows.map(([key, label]) => (
              <div key={key} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="break-all text-foreground">{source[key]}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">No campaign details were captured: they arrived directly.</p>
        )}
      </div>
    </section>
  );
}

/**
 * The small card on /leads for a member who owns a website. The page decides
 * whether to render it (owner of a website only); there is no nav item.
 */
export function WebsiteEntryCard({ site }: { site: WebsiteCardInput }) {
  const m = websiteCardModel(site);
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">Your website</p>
        <p className="mt-0.5 text-xs text-muted-foreground">Status: {m.statusLabel}</p>
      </div>
      {m.href && m.linkLabel ? (
        <Link href={m.href} className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted">
          {m.linkLabel}
        </Link>
      ) : null}
    </div>
  );
}
