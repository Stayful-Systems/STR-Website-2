import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { renderSitePage } from "@/lib/websites/render";
import { canonicalFor, loadLiveSite } from "../site-data";

/**
 * Batch 31: the fixed pages of a customer's website: fees, about, faq and
 * privacy. Anything else under the site (including "areas" on its own, which
 * is not a page) is a 404. Area pages live at areas/[area].
 */
export const dynamic = "force-dynamic";

const PAGES = ["fees", "about", "faq", "privacy"] as const;

type Props = { params: Promise<{ slug: string; page: string }> };

const isPage = (v: string): boolean => (PAGES as readonly string[]).includes(v);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, page } = await params;
  if (!isPage(page)) return {};
  const live = await loadLiveSite(slug);
  const found = live?.pages.find((p) => p.path === page);
  return found && live ? { title: found.title, alternates: canonicalFor(live.row, page) } : {};
}

export default async function SiteFixedPage({ params }: Props) {
  const { slug, page } = await params;
  if (!isPage(page)) notFound();
  const live = await loadLiveSite(slug);
  if (!live) notFound();
  const body = renderSitePage(live.pages, page);
  if (!body) notFound();
  return body;
}
