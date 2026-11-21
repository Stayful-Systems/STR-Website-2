import type { CSSProperties } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createAdminClient, hasServiceRole } from "@/lib/supabase/admin";
import { pageAt, type PageModel } from "@/lib/websites/page-model";
import { sitePagesOf } from "@/lib/websites/render";
import { siteById } from "@/lib/websites/store-server";
import { SitePage } from "@/lib/websites/templates/pages";
import { siteThemeVars } from "@/lib/websites/templates/SiteShell";
import { verifyTransferToken } from "@/lib/websites/transfer-token";
import { FORM_MARKER_ATTR } from "@/lib/websites/transfer-export";
import { siteAbsoluteUrl, siteDomain } from "@/lib/websites/urls";

/**
 * Batch 37: one page of a customer's website, drawn for the static export.
 *
 * The transfer engine fetches this for every page of the site, then hands the HTML to the pure
 * converter (src/lib/websites/transfer-export.ts). The address carries a signed token (15 minutes,
 * transfer-token.ts); a bad, expired or keyless token is a 404, and so is a transfer that is
 * cancelled, a site with no copy and a path that is not one of its pages. Any website status is
 * drawn (a paused site can be moved too); the same page is never cached: force-dynamic.
 *
 * The lead form is replaced by an empty marker the converter swaps for a static form, so no
 * client component is rendered here. noindex: this address is for our own fetch, never a search result.
 */
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ token: string; path?: string[] }> };

const SEGMENT = /^[a-z0-9-]{1,60}$/;

async function loadExport(token: string, segments: string[] | undefined) {
  const transferId = verifyTransferToken(token, new Date());
  if (!transferId || !hasServiceRole()) return null;
  const parts = segments ?? [];
  if (parts.length > 2 || !parts.every((s) => SEGMENT.test(s))) return null;
  const { data, error } = await createAdminClient().from("website_transfers").select("website_id").eq("id", transferId).is("cancelled_at", null).maybeSingle();
  if (error || !data) return null;
  const row = await siteById(String((data as { website_id: unknown }).website_id));
  if (!row) return null;
  const pages = sitePagesOf(row, row.settings, row.pages);
  if (!pages) return null;
  const page: PageModel | null = pageAt(pages, parts.join("/"));
  return page ? { row, page } : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token, path } = await params;
  const found = await loadExport(token, path);
  if (!found) return { robots: { index: false, follow: false } };
  const { row, page } = found;
  const name = row.settings.companyName.trim();
  const logo = row.settings.logoUrl;
  return {
    title: page.title,
    description: name ? `Find out what your property could earn as a short-term let, from ${name}.` : "Find out what your property could earn as a short-term let.",
    robots: { index: false, follow: false },
    ...(logo ? { icons: { icon: logo } } : {}),
    ...(siteDomain(row) ? { alternates: { canonical: siteAbsoluteUrl(row, page.path) } } : {}),
  };
}

export default async function TransferExportPage({ params }: Props) {
  const { token, path } = await params;
  const found = await loadExport(token, path);
  if (!found) notFound();
  const { page } = found;
  const style = { ...siteThemeVars(page.site), colorScheme: "light" } as CSSProperties;
  return (
    <div style={style}>
      <SitePage
        page={page}
        renderForm={(props) => <div {...{ [FORM_MARKER_ATTR]: props.pageKey }} />}
      />
    </div>
  );
}
