import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ownerIdOrNull } from "@/lib/leads/scope";
import { isAdminEmail } from "@/lib/admin";
import { packEligibility, readAdPacksEnabled } from "@/lib/ad-packs/eligibility-server";
import { areaPreview, listDistricts, matchArea } from "@/lib/ad-packs/area-server";
import { listPackForOwner } from "@/lib/ad-packs/generate-server";
import { signedPreviewUrls } from "@/lib/ad-packs/files-server";
import { ownUploadRef } from "@/lib/ad-packs/photos";
import { LiveActions } from "./LiveActions";
import { CannotUseScreen, GalleryScreen, MoreOptions, ProblemScreen, StartScreen, WorkingScreen } from "./Screens";
import { StartForm, type PhotoItem } from "./StartForm";
import { Calm } from "./ui";
import { ConnectSheet } from "./ConnectSheet";
import { YourAds } from "./YourAds";
import { packScreen, regenView } from "./state";
import { adViewModel, approvalVm, areaPreviewView, brandOfSettings, brandProblemText, eligibilityView, figureCallout, previewPathsOf, problemView, regenIntro, stageOf, voiceVm, type AreaPreviewView } from "./view";

export const metadata: Metadata = { title: "Your Facebook ads — Stayful Intelligence", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";
// Making the ads renders their pictures in the request that asks for it (the form's server action runs under this page's limit).
export const maxDuration = 60;

export default async function AdsPage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  // The account owner's to set up; a team member works the leads.
  const ownerId = await ownerIdOrNull(user);
  if (!ownerId) redirect("/leads");
  const admin = isAdminEmail(user.email);

  // ── Cannot use yet ──
  const elig = await packEligibility(user.id, { admin });
  if (!elig.eligible || !elig.website || !elig.domain) return <CannotUseScreen view={eligibilityView(elig.reasons)} />;

  const { brand, problems } = brandOfSettings(elig.website.settings);
  const view = await listPackForOwner(ownerId);
  const screen = packScreen(view, new Date().getTime());
  const previewNotice = admin && !(await readAdPacksEnabled()) ? <Calm live={false}>Admin preview: the Facebook ads switch is off, so operators cannot see this yet.</Calm> : null;

  // ── The pictures are being made right now ──
  if (screen.kind === "working") {
    return (
      <LiveActions>
        <WorkingScreen notice={previewNotice} />
      </LiveActions>
    );
  }

  // The area pick list is needed to make ads and to change the area of the ones already made.
  const options = await listDistricts();
  const areas = options.map((o) => ({ areaKey: o.areaKey, label: o.label }));

  // ── The first screen ──
  if (screen.kind === "start") {
    const matched = matchArea(brand.areas, options);
    const initialAreaKey = matched?.areaKey ?? null;
    const initialAreaPreview: AreaPreviewView | null = initialAreaKey ? areaPreviewView(await areaPreview({ areaKey: initialAreaKey })) : null;
    const failedBefore = view?.pack.status === "failed" || screen.failedBefore;
    return (
      <LiveActions>
        <StartScreen failed={failedBefore} notice={previewNotice}>
          <StartForm
            mode="start"
            packId={view?.pack.id ?? null}
            areas={areas}
            initialAreaKey={initialAreaKey}
            initialAreaPreview={initialAreaPreview}
            initialPhotos={[]}
            hasLogo={brand.logoUrl !== null}
            problems={problems.map(brandProblemText)}
            failedBefore={failedBefore}
          />
        </StartScreen>
      </LiveActions>
    );
  }

  // From here the ads exist.
  if (!view) return null;
  const { pack } = view;

  // "Make new ads": this ad set's place and photos, the brand as it is now.
  const regen = regenView(view, { company: brand.company, logoUrl: brand.logoUrl, brandColour: brand.brandColour, feePct: brand.feePct });
  const packPhotos = (pack.photos ?? []).filter((ref) => ownUploadRef(ownerId, ref));
  const ads = screen.kind === "checks_failed" ? [] : view.ads;
  const urls = await signedPreviewUrls(ownerId, [...ads.flatMap((a) => previewPathsOf(a.files)), ...packPhotos]);
  const initialPhotos: PhotoItem[] = packPhotos.map((ref) => ({ ref, url: urls.get(ref) ?? null }));
  const currentKey = pack.areaKey ?? null;
  const regenAreas = currentKey && !areas.some((a) => a.areaKey === currentKey) ? [{ areaKey: currentKey, label: pack.areaLabel ?? currentKey }, ...areas] : areas;
  const regenPreview: AreaPreviewView | null = currentKey ? areaPreviewView(await areaPreview({ areaKey: currentKey })) : null;
  const regenerate = regen.left > 0 ? (
    <StartForm
      mode="again"
      packId={pack.id}
      areas={regenAreas}
      initialAreaKey={currentKey}
      initialAreaPreview={regenPreview}
      initialPhotos={initialPhotos}
      hasLogo={brand.logoUrl !== null}
      problems={problems.map(brandProblemText)}
      blockReason={regen.reason}
    />
  ) : null;
  const intro = regen.left > 0 || regen.reason ? regenIntro(regen.left, regen.reason) : null;

  // ── The ads did not come out right ──
  if (screen.kind === "checks_failed") {
    return (
      <LiveActions>
        <ProblemScreen view={problemView(pack.checks)} more={<MoreOptions pack={{ id: pack.id, version: pack.version }} voice={voiceVm(view.voice)} canChangeVoice={false} regenerate={regenerate} regenIntro={intro} />} />
      </LiveActions>
    );
  }

  // ── Making (the video is on its way), ready to look at, ready to use ──
  const adVms = ads.map((a) => adViewModel(a, (path) => urls.get(path) ?? null, a.angle === "5b" ? view.video : null));
  const videoState = adVms.find((a) => a.video)?.video?.card.state ?? null;
  const stage = stageOf(screen.kind, videoState);
  if (stage !== "making" && stage !== "review" && stage !== "approved") return null;
  const voice = voiceVm(view.voice);
  const packRef = { id: pack.id, version: pack.version };
  return (
    <LiveActions>
      <GalleryScreen
        stage={stage}
        ads={adVms}
        pack={packRef}
        voice={voice}
        approval={approvalVm(view)}
        notice={screen.notice}
        figure={figureCallout(pack.figures)}
        more={stage === "making" ? null : <MoreOptions pack={packRef} voice={voice} canChangeVoice={stage === "review"} regenerate={regenerate} regenIntro={intro} />}
      />
      {previewNotice}
      {stage === "approved" ? <ConnectSheet forms={adVms.map((a, i) => ({ id: a.id, title: a.heading, questions: ads[i].leadForm }))} /> : null}
      {stage === "approved" ? <YourAds ownerId={ownerId} ads={ads.map((a) => ({ id: a.id, ownerId: a.ownerId, code: a.code, angle: a.angle }))} /> : null}
    </LiveActions>
  );
}
