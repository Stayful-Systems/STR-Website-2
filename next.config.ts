import type { NextConfig } from "next";
import { FRAME_HEADERS } from "./src/lib/security/frame-headers";

/**
 * The PDF report reads its typefaces and wordmark from disk at render time.
 * Nothing else in this app touches the filesystem at runtime, so without these
 * entries the files are absent from the serverless bundle: the report renders
 * correctly under `next dev` and silently drops to Helvetica in production.
 *
 * Every route that renders a PDF must be listed. `/api/internal/crm-deliveries`
 * is easy to miss — the cron drains the queue and attaches the report to a
 * customer's CRM from there.
 */
const PDF_ASSETS = [
  "src/lib/pdf/fonts/**/*",
  "public/assets/stayful-logo.png",
];

/**
 * Batch 36: the ad pack's image cards read their OFL typefaces from disk at
 * render time (src/lib/ad-packs/images.tsx), for the same reason as the PDF.
 * List every route that can call the generator (the /leads/ads page covers its
 * server actions).
 */
const AD_PACK_FONTS = ["src/lib/ad-packs/fonts/**/*"];

/**
 * Batch 36: the setup guide checks at render time which of its screenshots
 * exist (src/lib/ad-packs/guide-server.ts), so the folder travels with /leads/ads.
 */
const AD_PACK_GUIDE_SHOTS = ["public/ad-packs/guide/*.png"];

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/generate-pdf": PDF_ASSETS,
    "/r/[token]/pdf": PDF_ASSETS,
    "/api/v1/reports/[id]/pdf": PDF_ASSETS,
    "/api/analyse": PDF_ASSETS,
    "/api/internal/crm-deliveries": PDF_ASSETS,
    // Batch 23: Stayful Intelligence's contact card embeds its photo.
    "/si/card": ["public/images/si-contact.png"],
    "/leads/ads": [...AD_PACK_FONTS, ...AD_PACK_GUIDE_SHOTS],
    "/admin/ad-packs": AD_PACK_FONTS,
  },
  images: {
    formats: ["image/avif", "image/webp"],
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 2400],
    imageSizes: [64, 96, 128, 200, 256, 384, 512],
  },
  // Batch 19: other sites, and Meta's pixel, only ever see our origin as the
  // referrer, never a page's path or query (which can hold an address, an
  // email or a share token).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "Referrer-Policy", value: "strict-origin" }],
      },
      // Batch 22f: only the lead form (/f/*) may be embedded on other sites.
      ...FRAME_HEADERS,
    ];
  },
  async redirects() {
    return [
      {
        source: "/about",
        destination: "/methodology",
        permanent: true,
      },
      // R3 (R2-159): /home is Batch 22e's Home page, the landing after every sign-in; it is never redirected.
      // Batch 21: the orphan second analyser (invented market data, nothing
      // linked to it) is gone; an old link lands on the real one.
      {
        source: "/str-report",
        destination: "/estimate",
        permanent: true,
      },
      {
        source: "/str-report/presentation",
        destination: "/estimate",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
