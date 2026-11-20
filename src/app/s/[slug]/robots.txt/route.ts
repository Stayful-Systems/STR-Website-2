import { siteDomain } from "@/lib/websites/urls";
import { liveSiteBySlug } from "@/lib/websites/store-server";

/**
 * Batch 33: robots.txt for a customer's own domain. The proxy rewrites
 * https://<domain>/robots.txt here, and the site is indexable there, so
 * crawlers are welcome. A site with no domain (the temporary /s/<slug>
 * address, which is noindex) has no robots.txt: a 404.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const site = await liveSiteBySlug(slug);
  if (!site || !siteDomain(site)) return new Response("Not found", { status: 404 });
  return new Response("User-agent: *\nAllow: /\n", { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}
