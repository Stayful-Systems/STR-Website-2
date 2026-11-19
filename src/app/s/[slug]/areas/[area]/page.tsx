import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { renderSitePage } from "@/lib/websites/render";
import { loadLiveSite } from "../../site-data";

/**
 * Batch 31: one page per area the operator covers, at areas/<area slug>. An
 * area the site does not list is a 404.
 */
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string; area: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, area } = await params;
  const live = await loadLiveSite(slug);
  const found = live?.pages.find((p) => p.key === "area" && p.area?.slug === area);
  return found ? { title: found.title } : {};
}

export default async function SiteAreaPage({ params }: Props) {
  const { slug, area } = await params;
  const live = await loadLiveSite(slug);
  if (!live) notFound();
  const body = renderSitePage(live.pages, `areas/${area}`);
  if (!body) notFound();
  return body;
}
