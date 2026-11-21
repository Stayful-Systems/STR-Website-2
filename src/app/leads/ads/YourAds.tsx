import Link from "next/link";
import { logActivity } from "@/lib/activity/log";
import { ownerRanking } from "@/lib/ad-sheets/ranking-server";
import { NOT_ENOUGH_TITLE, type AdRankRow, type RankAdRef, type RankedRow } from "@/lib/ad-sheets/ranking";

/**
 * Batch 35 (Phase 9): "Your ads". Which of the pack's ads brought the leads that
 * reached a meeting and signed. A server component, read only: counts from the
 * operator's own leads (src/lib/ad-sheets/ranking-server.ts), no spend, no cost
 * per lead, no benchmark. Opening it logs the record-only `ad_ranking_viewed`
 * (fire and forget; a lead is never logged). Leads with no ad are "Ad unknown":
 * in the totals, never in the ranking.
 */

const card = "rounded-xl border border-border bg-card p-4 sm:p-5";

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold text-foreground">{value}</dd>
    </div>
  );
}

function AdRow({ row, rank }: { row: AdRankRow; rank: number | null }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
      <span className="text-sm font-medium text-foreground">
        {rank !== null ? <span className="mr-2 text-muted-foreground">{rank}.</span> : null}
        {row.label}
      </span>
      <span className="text-sm text-muted-foreground">
        {row.leads} {row.leads === 1 ? "lead" : "leads"} · {row.meetings} {row.meetings === 1 ? "meeting" : "meetings"} · {row.signed} signed
      </span>
    </li>
  );
}

export async function YourAds({ ownerId, ads }: { ownerId: string; ads: RankAdRef[] }) {
  const view = await ownerRanking(ownerId, ads);
  if (!view) return null;
  logActivity(ownerId, "ad_ranking_viewed", { extras: { ranked: view.ranked.length, leads: view.totals.leads } });

  return (
    <section id="your-ads" className={card} aria-label="Your ads">
      <h2 className="text-base font-semibold text-foreground">Your ads</h2>
      <p className="mt-1 text-sm text-muted-foreground">Which of your ads brought the landlords who went on to a meeting and to signing.</p>

      {view.outcomeNote ? (
        <p role="status" className="mt-3 rounded-md border border-border bg-muted/40 p-3 text-sm text-foreground">
          <span className="font-medium">{view.outcomeNote.title}.</span> {view.outcomeNote.text}{" "}
          <Link href={view.outcomeNote.href} className="font-medium underline underline-offset-2">Go to your leads</Link>
        </p>
      ) : null}

      {view.empty ? (
        <p className="mt-3 text-sm text-foreground">{view.emptyText}</p>
      ) : (
        <>
          <dl className="mt-3 grid grid-cols-3 gap-3 border-b border-border pb-3">
            <Stat label="Leads" value={view.totals.leads} />
            <Stat label="Meetings" value={view.totals.meetings} />
            <Stat label="Signed" value={view.totals.signed} />
          </dl>

          <p className="mt-3 text-xs text-muted-foreground">{view.rankingNote}</p>
          {view.ranked.length > 0 ? (
            <ol className="mt-1 divide-y divide-border" aria-label="Ads, best first">
              {view.ranked.map((r: RankedRow) => <AdRow key={r.adId} row={r} rank={r.rank} />)}
            </ol>
          ) : null}

          {view.notEnough.length > 0 ? (
            <div className="mt-4">
              <h3 className="text-sm font-semibold text-foreground">{NOT_ENOUGH_TITLE}</h3>
              <ul className="mt-1 divide-y divide-border">
                {view.notEnough.map((r) => <AdRow key={r.adId} row={r} rank={null} />)}
              </ul>
            </div>
          ) : null}

          {view.untagged.leads > 0 ? (
            <div className="mt-4 border-t border-border pt-3">
              <h3 className="text-sm font-semibold text-foreground">{view.untagged.label}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {view.untagged.leads} {view.untagged.leads === 1 ? "lead" : "leads"} · {view.untagged.meetings} {view.untagged.meetings === 1 ? "meeting" : "meetings"} · {view.untagged.signed} signed. These are in the totals above and left out of the ranking.
              </p>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
