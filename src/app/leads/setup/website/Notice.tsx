import Link from "next/link";
import { siteUrl } from "@/lib/url";
import { siteHref } from "@/lib/websites/urls";
import { SetupFrame } from "../SetupFrame";
import type { SetupContext } from "./context";
import { WEBSITE_STEPS } from "./steps";

const LABELS = WEBSITE_STEPS.map((s) => s.label);

/** Batch 31: what the setup shows instead of its steps: a live or paused site, or a plan that is needed first. */
export function Notice({ ctx }: { ctx: Exclude<SetupContext, { kind: "ready" }> }) {
  if (ctx.kind === "plan_required") {
    return (
      <SetupFrame step={1} back={null} title="Your website needs a plan" progress={{ labels: LABELS, current: 1 }} intro={<p>Going live with your website needs a paid plan. Your work so far is saved.</p>}>
        <Link href="/account" className="text-sm font-medium underline underline-offset-2">Go to your account</Link>
      </SetupFrame>
    );
  }
  const { site } = ctx.actor;
  const address = siteUrl(siteHref(site, ""));
  const paused = site.status === "paused";
  return (
    <SetupFrame
      step={1}
      back={null}
      title={paused ? "Your website is paused" : "Your website is live"}
      progress={{ labels: LABELS, current: 5 }}
      intro={paused ? <p>Your website is switched off for now. Get in touch if you would like it back on.</p> : <p>Landlords who visit it can ask for a free estimate, and their details land in Leads.</p>}
    >
      {paused ? null : (
        <p className="text-sm text-foreground">
          <a href={address} className="font-medium underline underline-offset-2" target="_blank" rel="noreferrer">{address}</a>
        </p>
      )}
      <p className="mt-6 text-xs text-muted-foreground">
        See your landlords in <Link href="/leads" className="underline underline-offset-2">Leads</Link>.
      </p>
    </SetupFrame>
  );
}
