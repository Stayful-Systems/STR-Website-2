import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ownerIdOrNull } from "@/lib/leads/scope";
import { isAdminEmail } from "@/lib/admin";
import { packEligibility } from "@/lib/ad-packs/eligibility-server";
import { listPackForOwner } from "@/lib/ad-packs/generate-server";
import { signedPreviewUrls } from "@/lib/ad-packs/files-server";
import { availableGuideShots } from "@/lib/ad-packs/guide-server";
import { LiveActions } from "../LiveActions";
import { packScreen } from "../state";
import { btnPrimary, Calm, card, INK, PageFrame } from "../ui";
import { ADS_PATH, adViewModel, eligibilityView, previewPathsOf } from "../view";
import { audienceChecklistFor } from "@/lib/ad-packs/guide";
import { coverageOfPack } from "@/lib/ad-packs/coverage";
import { GuideWizard, type GuideAd } from "./GuideWizard";

export const metadata: Metadata = { title: "Put your ads on Facebook — Stayful Intelligence", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const TITLE = "Put your ads on Facebook";
const BACK = { href: ADS_PATH, label: "← Back to my ads" };

/**
 * The step-by-step guide on its own page. The account owner's only, like the ads
 * page, and only once they have said their ads look good: until then there is a
 * plain message and a button back.
 */
export default async function GuidePage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const ownerId = await ownerIdOrNull(user);
  if (!ownerId) redirect("/leads");
  const admin = isAdminEmail(user.email);

  const elig = await packEligibility(user.id, { admin });
  if (!elig.eligible || !elig.website || !elig.domain) {
    const v = eligibilityView(elig.reasons);
    return (
      <PageFrame title={TITLE} back={BACK}>
        <section className={`${card} space-y-3`}>
          <h2 className={`text-xl font-bold ${INK}`}>{v.title}</h2>
          <p className={`text-lg leading-relaxed ${INK}`}>{v.message}</p>
        </section>
      </PageFrame>
    );
  }

  const view = await listPackForOwner(ownerId);
  const screen = packScreen(view, new Date().getTime());
  if (!view || screen.kind !== "approved") {
    return (
      <PageFrame title={TITLE} back={BACK}>
        <section className={`${card} space-y-4`}>
          <h2 className={`text-xl font-bold ${INK}`}>First, look at your ads</h2>
          <Calm live={false}>These steps open once you have looked at your ads and pressed the green button that says they look good.</Calm>
          <Link href={ADS_PATH} className={btnPrimary}>
            Go to my ads
          </Link>
        </section>
      </PageFrame>
    );
  }

  const urls = await signedPreviewUrls(ownerId, view.ads.flatMap((a) => previewPathsOf(a.files)));
  const adVms = view.ads.map((a) => adViewModel(a, (path) => urls.get(path) ?? null, a.angle === "5b" ? view.video : null));
  const ads: GuideAd[] = adVms.map((a) => {
    const poster = a.video?.poster ? (a.video.urls[a.video.poster] ?? null) : null;
    const pictures = a.cards.map((c) => c.previewUrl).filter((u): u is string => u !== null);
    return {
      id: a.id,
      heading: a.heading,
      blurb: a.blurb,
      isVideo: a.video !== null,
      cover: a.video ? poster : (pictures[0] ?? null),
      previews: a.video ? (poster ? [poster] : []) : pictures,
      pictureCount: a.video ? 0 : a.cards.length,
      copy: a.copy,
      downloads: a.downloads,
    };
  });

  return (
    <PageFrame title={TITLE} back={BACK} compact>
      <LiveActions>
        <GuideWizard ads={ads} shots={availableGuideShots()} packId={view.pack.id} {...(view.pack.route === "leaddb" ? { audienceChecklist: audienceChecklistFor(coverageOfPack(view.pack)) } : {})} />
      </LiveActions>
    </PageFrame>
  );
}
