"use client";

import Link from "next/link";
import { AdsActionsProvider } from "@/app/leads/ads/ActionsContext";
import { CannotUseScreen, GalleryScreen, MoreOptions, ProblemScreen, StartScreen, WorkingScreen } from "@/app/leads/ads/Screens";
import { StartForm } from "@/app/leads/ads/StartForm";
import { GuideWizard, type GuideAd } from "@/app/leads/ads/guide/GuideWizard";
import { PageFrame } from "@/app/leads/ads/ui";
import { ADS_PATH, eligibilityView, problemView, regenIntro, type ApprovalVm } from "@/app/leads/ads/view";
import { GUIDE_STEPS } from "@/lib/ad-packs/guide";
import { AREAS, AREA_PREVIEW, FAKE_ACTIONS, FIGURE, PACK, VOICE, VOICE_FREE, adsFor, type VideoCase } from "./fixtures";

/**
 * Batch 38c: the development preview. One component per screen, fed by
 * fixtures.ts and pretend actions. The list of screens is the first thing you
 * see; ?state=<name> shows one.
 */

const GUIDE_SHOTS = GUIDE_STEPS.map((s) => s.id);

function guideAds(): GuideAd[] {
  return adsFor("ready").map((a) => {
    const poster = a.video?.poster ? (a.video.urls[a.video.poster] ?? null) : null;
    const pictures = a.cards.map((c) => c.previewUrl).filter((u): u is string => u !== null);
    return { id: a.id, heading: a.heading, blurb: a.blurb, isVideo: a.video !== null, cover: a.video ? poster : (pictures[0] ?? null), previews: a.video ? (poster ? [poster] : []) : pictures, pictureCount: a.video ? 0 : a.cards.length, copy: a.copy, downloads: a.downloads };
  });
}

const OK: ApprovalVm = { ok: true };
const NOT_YET: ApprovalVm = { ok: false, message: "This button works as soon as your video is ready." };

function regenForm(blockReason: string | null) {
  return <StartForm mode="again" packId={PACK.id} areas={AREAS} initialAreaKey="NG7" initialAreaPreview={AREA_PREVIEW} initialPhotos={[]} hasLogo problems={[]} blockReason={blockReason} />;
}

function more(canChangeVoice: boolean) {
  return <MoreOptions pack={PACK} voice={VOICE} canChangeVoice={canChangeVoice} regenerate={regenForm(null)} regenIntro={regenIntro(1, null)} />;
}

function gallery(stage: "making" | "review" | "approved", video: VideoCase, approval: ApprovalVm, voice = VOICE) {
  return <GalleryScreen stage={stage} ads={adsFor(video)} pack={PACK} voice={voice} approval={approval} notice={null} figure={FIGURE} more={stage === "making" ? null : more(stage === "review")} />;
}

type Entry = { label: string; render: () => React.ReactNode };

const SCREENS: Record<string, Entry> = {
  "cannot-use": { label: "Cannot use yet (no address)", render: () => <CannotUseScreen view={eligibilityView(["no_domain"])} /> },
  "cannot-use-owner": { label: "Cannot use yet (not the owner)", render: () => <CannotUseScreen view={eligibilityView(["not_owner"])} /> },
  start: { label: "Start (website has no logo)", render: () => <StartScreen failed={false}><StartForm mode="start" packId={null} areas={AREAS} initialAreaKey="NG7" initialAreaPreview={AREA_PREVIEW} initialPhotos={[]} hasLogo={false} problems={[]} /></StartScreen> },
  "start-leaddb": { label: "Start (lead database customer, no colour yet)", render: () => <StartScreen failed={false}><StartForm mode="start" packId={null} areas={AREAS} initialAreaKey="NG7" initialAreaPreview={AREA_PREVIEW} initialPhotos={[]} hasLogo={false} problems={[]} brand={{ companyName: "Brightstone Stays", brandColour: null, logoUrl: null }} /></StartScreen> },
  "start-logo": { label: "Start (website has a logo)", render: () => <StartScreen failed={false}><StartForm mode="start" packId={null} areas={AREAS} initialAreaKey={null} initialAreaPreview={null} initialPhotos={[]} hasLogo problems={[]} /></StartScreen> },
  "start-failed": { label: "Start (last try failed)", render: () => <StartScreen failed><StartForm mode="start" packId="pack-1" areas={AREAS} initialAreaKey="NG7" initialAreaPreview={AREA_PREVIEW} initialPhotos={[]} hasLogo problems={[]} failedBefore /></StartScreen> },
  working: { label: "Pictures being made", render: () => <WorkingScreen /> },
  making: { label: "Making (video being made)", render: () => gallery("making", "making", NOT_YET) },
  "making-failed": { label: "Making (video failed, try again)", render: () => gallery("making", "failed-retry", NOT_YET) },
  "making-voice": { label: "Making (voice not available)", render: () => gallery("making", "failed-voice", NOT_YET, VOICE_FREE) },
  "making-contact": { label: "Making (video failed for good)", render: () => gallery("making", "failed-contact", NOT_YET) },
  review: { label: "Review (ready)", render: () => gallery("review", "ready", OK) },
  approved: { label: "Approved", render: () => gallery("approved", "ready", OK) },
  problem: { label: "Ads did not come out right", render: () => <ProblemScreen view={problemView({ failures: [{ check: "brand" }, { check: "length" }] })} more={more(false)} /> },
};

for (let i = 0; i < GUIDE_STEPS.length; i++) {
  SCREENS[`guide-${i + 1}`] = { label: `Guide step ${i + 1}: ${GUIDE_STEPS[i].title}`, render: () => <GuideScreen initial={{ phase: "step", adId: "ad-2", index: i }} /> };
}
SCREENS["guide-pick"] = { label: "Guide: which ad", render: () => <GuideScreen initial={{ phase: "pick" }} /> };
SCREENS["guide-video-upload"] = { label: "Guide: upload step for the video", render: () => <GuideScreen initial={{ phase: "step", adId: "ad-1", index: GUIDE_STEPS.findIndex((s) => s.id === "upload-file") }} /> };
SCREENS["guide-done"] = { label: "Guide: one ad done", render: () => <GuideScreen initial={{ phase: "done", adId: "ad-1" }} /> };

function GuideScreen({ initial }: { initial: { phase: "pick" | "step" | "done"; adId?: string; index?: number } }) {
  return (
    <PageFrame title="Put your ads on Facebook" back={{ href: ADS_PATH, label: "← Back to my ads" }} compact>
      <GuideWizard ads={guideAds()} shots={GUIDE_SHOTS} packId="preview" initial={initial} />
    </PageFrame>
  );
}

export function Preview({ state }: { state: string | undefined }) {
  const entry = state ? SCREENS[state] : undefined;
  return (
    <AdsActionsProvider actions={FAKE_ACTIONS}>
      {entry ? (
        entry.render()
      ) : (
        <PageFrame title="Ads preview" intro="Development only. Pick a screen.">
          <ul className="space-y-1">
            {Object.entries(SCREENS).map(([key, e]) => (
              <li key={key}>
                <Link href={`/dev/ads-preview?state=${key}`} className="inline-flex min-h-11 items-center text-base underline underline-offset-4">
                  {e.label}
                </Link>
              </li>
            ))}
          </ul>
        </PageFrame>
      )}
    </AdsActionsProvider>
  );
}
