import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { renderSitePage } from "@/lib/websites/render";
import { loadLiveSite } from "./site-data";

/** Batch 31: the home page of a customer's website. Layout carries the noindex, icon and brand. */
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const live = await loadLiveSite(slug);
  return live ? { title: live.pages[0].title } : {};
}

export default async function SiteHome({ params }: Props) {
  const { slug } = await params;
  const live = await loadLiveSite(slug);
  if (!live) notFound();
  const page = renderSitePage(live.pages, "");
  if (!page) notFound();
  return page;
}
