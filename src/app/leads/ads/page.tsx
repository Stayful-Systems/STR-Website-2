import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ownerIdOrNull } from "@/lib/leads/scope";
import { isAdminEmail } from "@/lib/admin";
import { packEligibility, readAdPacksEnabled } from "@/lib/ad-packs/eligibility-server";
import { areaPreview, listDistricts, matchArea } from "@/lib/ad-packs/area-server";
import { readPushedBedrooms } from "@/lib/leaddb/ad-profile-server";
import { listPackForOwner } from "@/lib/ad-packs/generate-server";
import { signedPreviewUrls } from "@/lib/ad-packs/files-server";
import { ownUploadRef } from "@/lib/ad-packs/photos";
import { coverageOfPack } from "@/lib/ad-packs/coverage";
import { LiveActions } from "./LiveActions";
import { CannotUseScreen, GalleryScreen, MoreOptions, ProblemScreen, StartScreen, WorkingScreen } from "./Screens";
import { StartForm, type PhotoItem } from "./StartForm";
import { Calm } from "./ui";
import { ConnectSheet } from "./ConnectSheet";
import { YourAds } from "./YourAds";
import { packScreen, regenView } from "./state";
import { adViewModel, approvalVm, BRAND_FIRST_LINK, profileHint, areaPreviewView, brandOfSettings, brandProblemText, eligibilityView, figureCallout, previewPathsOf, problemView, regenIntro, stageOf, voiceVm, type AreaPreviewView } from "./view";

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
  const adminNotice = admin && !(await readAdPacksEnabled()) ? <Calm live={false}>Admin preview: the Facebook ads switch is off, so operators cannot see this yet.</Calm> : null;
  // Batch 55 step 5 (A7): a lead database customer with no logo or no area is told what to add and where. Never blocks.
  const hint = elig.route === "leaddb" ? profileHint({ logoUrl: brand.logoUrl, areas: brand.areas }) : null;
  const hintNotice = hint ? (
    <Calm live={false}>
      {hint.text}{" "}
      <Link href={hint.href ?? "/leads/setup/website"} className="font-semibold underline">
        {hint.label}
      </Link>
    </Calm>
  ) : null;
  const previewNotice = adminNotice || hintNotice ? (
    <>
      {adminNotice}
      {hintNotice}
    </>
  ) : null;

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
  // Batch 55 step 5 (Phase 3): the lead database route asks "Anywhere in the UK" or "Choose areas" instead; the
  // customer's own areas (pushed from the lead database) are offered first.
  const leadDb = elig.route === "leaddb";
  const suggested = leadDb ? [...new Set(brand.areas.map((a) => matchArea([a], options)?.areaKey).filter((k): k is string => typeof k === "string"))] : [];

  // ── The first screen ──
  if (screen.kind === "start") {
    const matched = matchArea(brand.areas, options);
    const initialAreaKey = matched?.areaKey ?? null;
    // Batch 55 step 5: on the lead database route the preview shows the bedroom count the pack will use (the lowest pushed).
    const preferBeds = elig.route === "leaddb" ? await readPushedBedrooms(ownerId) : null;
    const initialAreaPreview: AreaPreviewView | null = initialAreaKey ? areaPreviewView(await areaPreview(preferBeds !== null ? { areaKey: initialAreaKey, bedrooms: preferBeds } : { areaKey: initialAreaKey })) : null;
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
            problems={problems.map((pr) => brandProblemText(pr, leadDb ? "leaddb" : "academy"))}
            {...(leadDb ? { problemLink: BRAND_FIRST_LINK } : {})}
            failedBefore={failedBefore}
            {...(leadDb ? { coverage: { options: areas, suggested, initialMode: "uk" as const, initialKeys: [] } } : {})}
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
  // Phase 3: "Make new ads" starts from what the ads say now (a pack made before Phase 3 reads as its one area).
  const packCoverage = coverageOfPack(pack);
  const byAdLabel = new Map(options.map((o) => [o.adLabel, o.areaKey]));
  const regenKeys = pack.coverage === null ? (currentKey ? [currentKey] : []) : packCoverage.areas.map((n) => byAdLabel.get(n)).filter((k): k is string => typeof k === "string");
  const regenCoverage = pack.route === "leaddb" ? { options: regenAreas, suggested, initialMode: packCoverage.mode, initialKeys: regenKeys } : null;
  const regenerate = regen.left > 0 ? (
    <StartForm
      mode="again"
      packId={pack.id}
      areas={regenAreas}
      initialAreaKey={currentKey}
      initialAreaPreview={regenPreview}
      initialPhotos={initialPhotos}
      hasLogo={brand.logoUrl !== null}
      problems={problems.map((pr) => brandProblemText(pr, pack.route === "leaddb" ? "leaddb" : "academy"))}
      {...(pack.route === "leaddb" ? { problemLink: BRAND_FIRST_LINK } : {})}
      blockReason={regen.reason}
      {...(regenCoverage ? { coverage: regenCoverage } : {})}
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
  const adVms = ads.map((a) => adViewModel(a, (path) => urls.get(path) ?? null, a.angle === "5b" ? view.video : null, pack.route === "leaddb" ? { route: "leaddb" } : undefined));
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
