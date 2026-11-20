import type { CSSProperties, ReactNode } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AttributionProvider } from "@/lib/websites/LeadForm";
import { siteThemeVars } from "@/lib/websites/templates/SiteShell";
import { siteDomain } from "@/lib/websites/urls";
import { loadLiveSite } from "./site-data";

/**
 * Batch 31: the frame for a customer's website at /s/<slug>.
 *
 * The root layout's Stayful title and favicons would otherwise show through on
 * a page that is supposed to be someone else's, so everything the tab shows is
 * overridden here, as the funnel does: the operator's company name as the
 * title, their logo as the icon (a neutral mark when there is none), never the
 * Stayful title or favicon. There is no Stayful header or banner: the only
 * mention is the footer line the shell draws.
 *
 * noindex, nofollow: while a site lives on the temporary /s/<slug> address it
 * must not compete with the operator's own site in search results. Batch 33:
 * once it has its own domain it is indexable (index, follow); each page then
 * names its own canonical address (canonicalFor, site-data.ts).
 *
 * Paused, preview and unknown sites are a 404. The page behind a live address
 * differs from the one behind a paused one at the very same URL, so nothing
 * here may be cached across requests: force-dynamic.
 *
 * AttributionProvider reads utm_*, fbclid, ad and the landing path from the
 * address once and holds them in memory (a React context), so every page's
 * form carries what the visitor arrived with. No storage, no cookies.
 */

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const live = await loadLiveSite(slug);
  const name = live?.row.settings.companyName.trim() || "";
  const logo = live?.row.settings.logoUrl ?? null;
  return {
    title: name || "Property income estimate",
    description: name ? `Find out what your property could earn as a short-term let, from ${name}.` : "Find out what your property could earn as a short-term let.",
    robots: { index: false, follow: false },
    // Batch 33: a site on its own domain is indexable.
    ...(live && siteDomain(live.row) ? { robots: { index: true, follow: true } } : {}),
    icons: logo ? { icon: logo } : { icon: "/icon-neutral.svg" },
  };
}

export default async function SiteLayout({ children, params }: { children: ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const live = await loadLiveSite(slug);
  if (!live) notFound();
  const home = live.pages[0];
  // The operator's brand as CSS custom properties on a wrapper, so everything
  // under it (the shell, the form, the not-found states) is themed the same way.
  const style = { ...siteThemeVars(home.site), colorScheme: "light" } as CSSProperties;
  return (
    <div style={style}>
      <AttributionProvider>{children}</AttributionProvider>
    </div>
  );
}
