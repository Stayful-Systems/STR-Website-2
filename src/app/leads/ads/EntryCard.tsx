import Link from "next/link";
import { adPackEntry } from "@/lib/ad-packs/entry-server";
import { ADS_PATH, entryCardView } from "./view";

/**
 * Batch 38 (Phase 8): the small "Your ad pack" card on /leads, for an eligible
 * account owner only (nothing at all for anyone else). Rendered inside a
 * Suspense boundary by the page, so the Leads list never waits for it. There
 * is no nav item: this card is the way in.
 */
export async function AdPackEntryCard({ userId }: { userId: string }) {
  const entry = await adPackEntry(userId);
  if (entry === false) return null;
  const v = entryCardView(entry.status);
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{v.title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{v.body}</p>
      </div>
      <Link href={ADS_PATH} className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted">
        {v.cta}
      </Link>
    </div>
  );
}
