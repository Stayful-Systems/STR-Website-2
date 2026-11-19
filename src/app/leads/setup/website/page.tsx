import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { websiteSetupContext } from "./context";
import { Notice } from "./Notice";
import { stepPath } from "./steps";

export const metadata: Metadata = { title: "Your website — Stayful Intelligence", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * Batch 31: the website setup's front door. Anyone arriving is sent to their
 * current step (the first one not done); a live or paused site gets a notice;
 * a team member, a member nobody invited and a non-management account are sent
 * to Leads (context.ts).
 */
export default async function WebsiteSetupStart() {
  const ctx = await websiteSetupContext();
  if (ctx.kind !== "ready") return <Notice ctx={ctx} />;
  redirect(stepPath(ctx.resume));
}
