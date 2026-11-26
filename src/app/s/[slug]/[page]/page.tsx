import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { renderCalculatorPage, renderSitePage } from "@/lib/websites/render";
import { isCalculatorMode } from "@/lib/websites/calculator";
import { canonicalFor, loadLiveSite } from "../site-data";

/**
 * Batch 31: the fixed pages of a customer's website: fees, about, faq and
 * privacy. Anything else under the site (including "areas" on its own, which
 * is not a page) is a 404. Area pages live at areas/[area].
 *
 * Batch 55: a calculator site has no fees, about or faq: those are a 404 in its
 * mode. Only the privacy page answers (the form's consent tick links to it).
 */
export const dynamic = "force-dynamic";

const PAGES = ["fees", "about", "faq", "privacy"] as const;

type Props = { params: Promise<{ slug: string; page: string }> };

const isPage = (v: string): boolean => (PAGES as readonly string[]).includes(v);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, page } = await params;
  if (!isPage(page)) return {};
  const live = await loadLiveSite(slug);
  if (live && isCalculatorMode(live.row.mode) && page !== "privacy") return {};
  const found = live?.pages.find((p) => p.path === page);
  return found && live ? { title: found.title, alternates: canonicalFor(live.row, page) } : {};
}

export default async function SiteFixedPage({ params }: Props) {
  const { slug, page } = await params;
  if (!isPage(page)) notFound();
  const live = await loadLiveSite(slug);
  if (!live) notFound();
  const calculator = isCalculatorMode(live.row.mode);
  if (calculator && page !== "privacy") notFound();
  const body = calculator ? renderCalculatorPage(live.pages, page) : renderSitePage(live.pages, page);
  if (!body) notFound();
  return body;
}
