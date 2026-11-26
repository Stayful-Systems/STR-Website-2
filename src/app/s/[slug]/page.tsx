import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { renderCalculatorPage, renderSitePage } from "@/lib/websites/render";
import { isCalculatorMode } from "@/lib/websites/calculator";
import { canonicalFor, loadLiveSite } from "./site-data";

/**
 * Batch 31: the home page of a customer's website. Layout carries the noindex, icon and brand.
 * Batch 55: a calculator site's home page is only the branded income form (no page copy, no navigation).
 */
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const live = await loadLiveSite(slug);
  if (live && isCalculatorMode(live.row.mode)) return { title: live.row.settings.companyName.trim() || "Property income estimate" };
  return live ? { title: live.pages[0].title, alternates: canonicalFor(live.row, "") } : {};
}

export default async function SiteHome({ params }: Props) {
  const { slug } = await params;
  const live = await loadLiveSite(slug);
  if (!live) notFound();
  const page = isCalculatorMode(live.row.mode) ? renderCalculatorPage(live.pages, "") : renderSitePage(live.pages, "");
  if (!page) notFound();
  return page;
}
