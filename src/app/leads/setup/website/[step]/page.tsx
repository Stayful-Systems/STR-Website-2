import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { WEBSITE_REGEN_CAP } from "@/lib/websites/copy-server";
import { SetupFrame } from "../../SetupFrame";
import { websiteSetupContext } from "../context";
import { Notice } from "../Notice";
import { WEBSITE_STEPS, parseStepParam, stepPath, type WebsiteStepNo } from "../steps";
import { WebsiteSetup } from "../WebsiteSetup";

export const metadata: Metadata = { title: "Your website — Stayful Intelligence", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";
// Step 5 writes the whole site with the model, and Approve fetches every public page.
export const maxDuration = 120;

const COPY: Record<WebsiteStepNo, { title: string; intro: string }> = {
  1: { title: "Your company and logo", intro: "Landlords see your name, logo and colour on every page of your website. Nothing says Stayful except a small footer line." },
  2: { title: "Where you work and what you charge", intro: "Each area gets its own page. Your management fee goes on your fees page exactly as you type it." },
  3: { title: "How landlords reach you", intro: "Shown on your website, and where landlords can get hold of you." },
  4: { title: "About you (optional)", intro: "A photo and a few words in your own voice make the About page yours. You can skip this." },
  5: { title: "Write, preview and approve", intro: "We write a first draft for free. Change any of it, check the preview, then approve to put your website live." },
};

const LABELS = WEBSITE_STEPS.map((s) => s.label);

export default async function WebsiteSetupStep({ params }: { params: Promise<{ step: string }> }) {
  const { step: raw } = await params;
  const step = parseStepParam(raw);
  if (!step) notFound();

  const ctx = await websiteSetupContext();
  if (ctx.kind !== "ready") return <Notice ctx={ctx} />;
  // Back is always fine; ahead of the first step not done is not.
  if (step > ctx.resume) redirect(stepPath(ctx.resume));

  const { site } = ctx.actor;
  return (
    <SetupFrame step={1} back={step > 1 ? stepPath((step - 1) as WebsiteStepNo) : null} title={COPY[step].title} intro={<p>{COPY[step].intro}</p>} progress={{ labels: LABELS, current: step }}>
      <WebsiteSetup step={step} slug={site.slug} settings={site.settings} copy={site.pages} regenUsed={site.regenCount} regenCap={WEBSITE_REGEN_CAP} />
    </SetupFrame>
  );
}
