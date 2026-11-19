import type { Metadata } from "next";

/**
 * Batch 31: the neutral frame for every customer-website URL, as /f has. A
 * slug that is not a live site falls to not-found.tsx under this layout, so it
 * carries no Stayful title and no Stayful icon; a live site's own layout
 * (s/[slug]/layout.tsx) overrides all of this with the operator's branding.
 */
export const metadata: Metadata = {
  title: "Property income estimate",
  description: "Find out what a property could earn as a short-term let.",
  robots: { index: false, follow: false },
  icons: { icon: "/icon-neutral.svg" },
};

export default function SitesLayout({ children }: { children: React.ReactNode }) {
  return children;
}
