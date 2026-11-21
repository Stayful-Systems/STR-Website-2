import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ownerIdOrNull } from "@/lib/leads/scope";
import { isAdminEmail } from "@/lib/admin";
import { packEligibility, readAdPacksEnabled } from "@/lib/ad-packs/eligibility-server";
import { areaPreview, listDistricts, matchArea } from "@/lib/ad-packs/area-server";
import { listPackForOwner } from "@/lib/ad-packs/generate-server";
import { signedPreviewUrls } from "@/lib/ad-packs/files-server";
import { ownUploadRef } from "@/lib/ad-packs/photos";
import { availableGuideShots } from "@/lib/ad-packs/guide-server";
import { AdSection } from "./AdSection";
import { Guide } from "./Guide";
import { ConnectSheet } from "./ConnectSheet";
import { ApproveForm, GenerateForm, type PhotoItem } from "./AdPackClient";
import { packScreen, regenView } from "./state";
import { adViewModel, approvalVm, areaPreviewView, brandOfSettings, brandProblemText, checksFailedView, eligibilityView, figureCallout, voiceVm, type AreaPreviewView } from "./view";

export const metadata: Metadata = { title: "Your ad pack — Stayful Intelligence", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";
// Making a pack renders 30 images in the request that asks for it (the form's server action runs under this page's limit).
export const maxDuration = 60;

const card = "rounded-xl border border-border bg-card p-4 sm:p-5";

function Frame({ intro, children }: { intro: React.ReactNode; children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-4xl space-y-5 px-4 pb-10 sm:px-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Your ad pack</h1>
          <div className="mt-1 text-sm text-muted-foreground">{intro}</div>
        </div>
        {children}
      </div>
    </main>
  );
}

const INTRO = "Three Facebook ads for landlords, in your own brand. You put them on your own Meta account, and every lead from them is recorded against the ad that brought it.";

export default async function AdsPage() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  // The account owner's to set up; a team member works the leads.
  const ownerId = await ownerIdOrNull(user);
  if (!ownerId) redirect("/leads");
  const admin = isAdminEmail(user.email);

  // ── Not eligible ──
  const elig = await packEligibility(user.id, { admin });
  if (!elig.eligible || !elig.website || !elig.domain) {
    const v = eligibilityView(elig.reasons);
    return (
      <Frame intro={INTRO}>
        <section className={card}>
          <h2 className="text-base font-semibold text-foreground">{v.title}</h2>
          <ul className="mt-2 space-y-2 text-sm text-foreground">
            {v.sentences.map((s) => <li key={s}>{s}</li>)}
          </ul>
          {v.next.length > 0 ? (
            <div className="mt-4 space-y-2 border-t border-border pt-4 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">What to do next</p>
              {v.next.map((n) => (
                <p key={n.text}>
                  {n.text}
                  {n.href && n.label ? <>{" "}<Link href={n.href} className="font-medium text-foreground underline underline-offset-2">{n.label}</Link></> : null}
                </p>
              ))}
            </div>
          ) : null}
        </section>
      </Frame>
    );
  }

  const { brand, problems } = brandOfSettings(elig.website.settings);
  const view = await listPackForOwner(ownerId);
  const screen = packScreen(view, new Date().getTime());
  const previewNotice = admin && !(await readAdPacksEnabled()) ? (
    <p className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">Admin preview: the ad pack switch is off, so operators cannot see this yet.</p>
  ) : null;
  const feeText = brand.feePct !== null ? `${brand.feePct}%` : null;

  // ── Being made ──
  if (screen.kind === "working") {
    return (
      <Frame intro={INTRO}>
        {previewNotice}
        <section className={card} role="status">
          <h2 className="text-base font-semibold text-foreground">Your pack is being made</h2>
          <p className="mt-1 text-sm text-muted-foreground">Give it a few minutes, then check again.</p>
          <Link href="/leads/ads" className="mt-4 inline-block rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted">Check again</Link>
        </section>
      </Frame>
    );
  }

  // The area pick list is needed to make a pack and to change the area of one.
  const options = await listDistricts();
  const areas = options.map((o) => ({ areaKey: o.areaKey, label: o.label }));

  // ── Confirm your main area (no pack yet, or a first attempt that failed) ──
  if (screen.kind === "start") {
    const matched = matchArea(brand.areas, options);
    const initialAreaKey = matched?.areaKey ?? null;
    const initialAreaPreview: AreaPreviewView | null = initialAreaKey ? areaPreviewView(await areaPreview({ areaKey: initialAreaKey })) : null;
    return (
      <Frame intro={INTRO}>
        {previewNotice}
        {view?.pack.status === "failed" || screen.failedBefore ? (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">Something went wrong making your pack last time. Nothing was lost. You can try again.</p>
        ) : null}
        <GenerateForm
          mode="start"
          packId={view?.pack.id ?? null}
          areas={areas}
          initialAreaKey={initialAreaKey}
          initialAreaPreview={initialAreaPreview}
          initialPhotos={[]}
          hasLogo={brand.logoUrl !== null}
          brand={{ company: brand.company, colour: brand.brandColour, logoUrl: brand.logoUrl, fee: feeText }}
          problems={problems.map(brandProblemText)}
          blockReason={null}
        />
      </Frame>
    );
  }

  // From here a pack exists.
  if (!view) return null;
  const { pack } = view;

  // The regenerate form: this pack's area and photos, the brand as it is now.
  const regen = regenView(view, { company: brand.company, logoUrl: brand.logoUrl, brandColour: brand.brandColour, feePct: brand.feePct });
  const packPhotos = (pack.photos ?? []).filter((ref) => ownUploadRef(ownerId, ref));
  const ads = screen.kind === "checks_failed" ? [] : view.ads;
  // The notice ad's video (once ready): the three sizes and the poster get view links too, so the player has its first link at once.
  const previewPaths = ads.flatMap((a) => [...a.files.images.map((f) => f.path), ...(a.files.video && a.files.video.status === "ready" ? [...a.files.video.videos, a.files.video.poster].map((f) => f.path) : [])]);
  const urls = await signedPreviewUrls(ownerId, [...previewPaths, ...packPhotos]);
  const initialPhotos: PhotoItem[] = packPhotos.map((ref) => ({ ref, url: urls.get(ref) ?? null }));
  const currentKey = pack.areaKey ?? null;
  const regenAreas = currentKey && !areas.some((a) => a.areaKey === currentKey) ? [{ areaKey: currentKey, label: pack.areaLabel ?? currentKey }, ...areas] : areas;
  const regenPreview: AreaPreviewView | null = currentKey ? areaPreviewView(await areaPreview({ areaKey: currentKey })) : null;
  const regenerateForm = regen.left > 0 || regen.reason ? (
    <section aria-label="Regenerate your ads">
      <h2 className="text-base font-semibold text-foreground">Change something and make your ads again</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {regen.left > 0 ? "You can regenerate once for free, after you change your logo, colour, company name, fee, photos or area." : regen.reason}
      </p>
      {regen.left > 0 ? (
        <div className="mt-3">
          <GenerateForm
            mode="regenerate"
            packId={pack.id}
            areas={regenAreas}
            initialAreaKey={currentKey}
            initialAreaPreview={regenPreview}
            initialPhotos={initialPhotos}
            hasLogo={brand.logoUrl !== null}
            brand={{ company: brand.company, colour: brand.brandColour, logoUrl: brand.logoUrl, fee: feeText }}
            problems={problems.map(brandProblemText)}
            blockReason={regen.reason}
            freeLeft={regen.left}
          />
        </div>
      ) : null}
    </section>
  ) : null;

  // ── We couldn't build your pack yet ──
  if (screen.kind === "checks_failed") {
    const v = checksFailedView(pack.checks);
    return (
      <Frame intro={INTRO}>
        {previewNotice}
        <section className={card} role="alert">
          <h2 className="text-base font-semibold text-foreground">{v.title}</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-foreground">
            {v.lines.map((l) => <li key={l}>{l}</li>)}
          </ul>
          <p className="mt-3 text-sm text-muted-foreground">{v.contact}</p>
        </section>
        {regenerateForm}
      </Frame>
    );
  }

  // ── Preview and approved ──
  const approved = screen.kind === "approved";
  const figure = figureCallout(pack.figures);
  const adVms = ads.map((a) => adViewModel(a, (path) => urls.get(path) ?? null, a.angle === "5b" ? view.video : null));
  const voice = voiceVm(view.voice);
  const approval = approvalVm(view);

  return (
    <Frame intro={approved ? "Your ads are ready. Download the images and copy every text, one tap each." : "Here are your three ads. Have a look, then approve them."}>
      {previewNotice}
      {screen.notice ? <p role="status" className="rounded-md border border-border bg-muted/40 p-3 text-sm text-foreground">{screen.notice}</p> : null}

      {figure ? (
        <section className={card} aria-label="The example figure">
          <h2 className="text-sm font-semibold text-foreground">The example figure in your ads</h2>
          <p className="mt-1 text-sm text-foreground">{figure.sentence || figure.label}</p>
          <p className="mt-2 text-xs text-muted-foreground">Every ad carries one example, always labelled as an example. It comes from real reports in your area, and we never promise what a landlord will earn.</p>
        </section>
      ) : null}

      {approved ? (
        <p className="text-sm">
          <a href="#guide" className="font-medium text-foreground underline underline-offset-2">How to put these on Facebook</a>
        </p>
      ) : null}

      {adVms.map((ad) => <AdSection key={ad.id} ad={ad} approved={approved} pack={{ id: pack.id, version: pack.version, voiceKey: pack.voiceKey }} voice={voice} />)}

      {approved || pack.status !== "preview" ? null : <ApproveForm packId={pack.id} version={pack.version} blockedReason={approval.ok ? null : approval.message} />}

      {approved ? (
        <section id="guide" className={card}>
          <h2 className="text-base font-semibold text-foreground">How to put these on Facebook</h2>
          <p className="mt-1 text-sm text-muted-foreground">One step at a time, on your own Meta account. We never touch it, and you can stop and come back whenever you like.</p>
          <div className="mt-4">
            <Guide
              ads={adVms.map((a) => ({ id: a.id, title: a.title, isVideo: a.video !== null, copy: a.copy }))}
              shots={availableGuideShots()}
              storageKey={pack.id}
            />
          </div>
        </section>
      ) : null}

      {approved ? <ConnectSheet forms={adVms.map((a, i) => ({ id: a.id, title: a.title, questions: ads[i].leadForm }))} /> : null}

      {regenerateForm}
    </Frame>
  );
}
