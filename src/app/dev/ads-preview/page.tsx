import { notFound } from "next/navigation";
import { devPreviewAllowed } from "./guard";
import { Preview } from "./Preview";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ads preview (development only)", robots: { index: false, follow: false } };

/**
 * Batch 38c: every screen of the Facebook ads, from made-up data and pretend
 * actions, so the design can be looked at (and screenshotted) without a
 * database, a session or an account. Development only: a 404 in a production
 * build and on Vercel (guard.ts). It imports no database and no server action.
 *
 *   /dev/ads-preview                  the list of screens
 *   /dev/ads-preview?state=review     one screen
 */
export default async function AdsPreviewPage({ searchParams }: { searchParams: Promise<{ state?: string | string[] }> }) {
  if (!devPreviewAllowed(process.env)) notFound();
  const { state } = await searchParams;
  return <Preview state={Array.isArray(state) ? state[0] : state} />;
}
