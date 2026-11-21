"use client";

import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAdsActions } from "./ActionsContext";
import { AdsGallery } from "./Gallery";
import { DownloadRow } from "./Downloads";
import { ChangeVoiceForm } from "./VideoBlock";
import type { AdsState } from "./ops";
import { Alert, btnPrimary, btnSecondary, Calm, card, INK, PageFrame, SOFT, Spinner, StickyBar } from "./ui";
import {
  APPROVE_BUTTON,
  APPROVE_EXPLAIN,
  GUIDE_PATH,
  MORE_OPTIONS_TITLE,
  PAGE_TITLE,
  POLL_GIVE_UP_MS,
  REGEN_NOTE,
  REGEN_TITLE,
  START_INTRO,
  VOICE_CHANGE_TITLE,
  type AdVm,
  type ApprovalVm,
  type EligibilityView,
  type ProblemView,
  type Stage,
  type VoiceVm,
} from "./view";

/**
 * Batch 38c: one component per screen of /leads/ads. Each is handed plain data
 * the page already decided (view.ts and state.ts hold the rules and the words)
 * and lays it out for a phone first: one column, big buttons, the main action
 * stuck to the bottom of the screen. Nothing here reads a database or checks who
 * may do what; the actions behind the buttons do (ops.ts).
 */

const INITIAL: AdsState = {};

// ── Cannot use yet ──

export function CannotUseScreen({ view }: { view: EligibilityView }) {
  return (
    <PageFrame title={PAGE_TITLE}>
      <section className={`${card} space-y-4`}>
        <h2 className={`text-xl font-bold ${INK}`}>{view.title}</h2>
        <p className={`text-lg leading-relaxed ${INK}`}>{view.message}</p>
        {view.next ? (
          <div className="space-y-3 border-t border-border pt-4">
            <p className={`text-base font-semibold ${INK}`}>What to do next</p>
            <p className={`text-base leading-relaxed ${INK}`}>{view.next.text}</p>
            {view.next.href && view.next.label ? (
              <Link href={view.next.href} className={btnPrimary}>
                {view.next.label}
              </Link>
            ) : null}
          </div>
        ) : null}
      </section>
    </PageFrame>
  );
}

// ── The first screen ──

export function StartScreen({ failed, notice, children }: { failed: boolean; notice?: React.ReactNode; children: React.ReactNode }) {
  return (
    <PageFrame title={PAGE_TITLE} intro={START_INTRO}>
      {notice}
      {failed ? <Alert>Something went wrong making your ads last time. Nothing was lost. You can try again.</Alert> : null}
      {children}
    </PageFrame>
  );
}

// ── The pictures are being made right now ──

export function WorkingScreen({ notice }: { notice?: React.ReactNode }) {
  const router = useRouter();
  const [slow, setSlow] = useState(false);

  // While this page is open, look again every few seconds; stop after a while.
  useEffect(() => {
    const startedMs = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - startedMs >= POLL_GIVE_UP_MS) {
        clearInterval(timer);
        setSlow(true);
        return;
      }
      router.refresh();
    }, 8000);
    return () => clearInterval(timer);
  }, [router]);

  return (
    <PageFrame title={PAGE_TITLE}>
      {notice}
      <section className={`${card} space-y-4`} role="status">
        <div className="flex items-center gap-3">
          <Spinner />
          <h2 className={`text-xl font-bold ${INK}`}>Your ads are being made</h2>
        </div>
        <p className={`text-lg leading-relaxed ${INK}`}>{slow ? "This is taking longer than usual. Please check again in a few minutes." : "This takes about a minute. This page updates by itself."}</p>
        <button type="button" onClick={() => router.refresh()} className={btnSecondary}>
          Check again
        </button>
      </section>
    </PageFrame>
  );
}

// ── The ads did not come out right ──

export function ProblemScreen({ view, more }: { view: ProblemView; more: React.ReactNode }) {
  return (
    <PageFrame title={PAGE_TITLE}>
      <section className={`${card} space-y-3`} role="alert">
        <h2 className={`text-xl font-bold ${INK}`}>{view.title}</h2>
        <ul className={`list-disc space-y-1 pl-5 text-lg leading-relaxed ${INK}`}>
          {view.lines.map((l) => <li key={l}>{l}</li>)}
        </ul>
        <p className={`text-base leading-relaxed ${SOFT}`}>{view.contact}</p>
      </section>
      {more}
    </PageFrame>
  );
}

// ── "Looks good" ──

function LooksGood({ packId, version, approval }: { packId: string; version: number; approval: ApprovalVm }) {
  const { approve } = useAdsActions();
  const [state, action, pending] = useActionState(approve, INITIAL);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="packId" value={packId} />
      <input type="hidden" name="version" value={version} />
      <section className={`${card} space-y-2`}>
        <h2 className={`text-xl font-bold ${INK}`}>Happy with your ads?</h2>
        <p className={`text-base leading-relaxed ${INK}`}>{APPROVE_EXPLAIN}</p>
        {approval.ok ? null : <Calm>{approval.message}</Calm>}
        {state.error ? <Alert>{state.error}</Alert> : null}
      </section>
      <StickyBar>
        <button type="submit" disabled={pending || !approval.ok} className={btnPrimary}>
          {pending ? "One moment…" : APPROVE_BUTTON}
        </button>
      </StickyBar>
    </form>
  );
}

// ── More options: change the voice, make new ads ──

export function MoreOptions({ pack, voice, canChangeVoice, regenerate, regenIntro }: { pack: { id: string; version: number }; voice: VoiceVm; canChangeVoice: boolean; regenerate: React.ReactNode | null; regenIntro: string | null }) {
  const showVoice = canChangeVoice;
  if (!showVoice && !regenIntro) return null;
  return (
    <details className="rounded-2xl border border-border bg-card">
      <summary className={`flex min-h-14 cursor-pointer items-center px-4 py-3 text-lg font-semibold ${INK}`}>{MORE_OPTIONS_TITLE}</summary>
      <div className="space-y-8 border-t border-border p-4 sm:p-6">
        {showVoice ? (
          <section className="space-y-3">
            <h3 className={`text-lg font-bold ${INK}`}>{VOICE_CHANGE_TITLE}</h3>
            {voice.canChange ? <ChangeVoiceForm packId={pack.id} version={pack.version} voice={voice} /> : <p className={`text-base ${SOFT}`}>{voice.blocked ?? voice.note}</p>}
          </section>
        ) : null}
        {regenIntro ? (
          <section className="space-y-3">
            <h3 className={`text-lg font-bold ${INK}`}>{REGEN_TITLE}</h3>
            <p className={`text-base leading-relaxed ${SOFT}`}>{regenIntro}</p>
            {regenerate ? (
              <>
                <p className={`text-base leading-relaxed ${SOFT}`}>{REGEN_NOTE}</p>
                {regenerate}
              </>
            ) : null}
          </section>
        ) : null}
      </div>
    </details>
  );
}

// ── The three ads: making, ready to look at, ready to use ──

export interface GalleryScreenProps {
  stage: Extract<Stage, "making" | "review" | "approved">;
  ads: AdVm[];
  pack: { id: string; version: number };
  voice: VoiceVm;
  approval: ApprovalVm;
  /** A line from the page (for example, that a newer try did not work and these are the earlier ads). */
  notice: string | null;
  figure: { label: string; sentence: string } | null;
  /** The "More options" box, made by the page (null when there is nothing to offer). */
  more: React.ReactNode;
}

const INTRO: Record<GalleryScreenProps["stage"], string> = {
  making: "Your pictures are ready. Your video is still being made.",
  review: "Have a look at your three ads, then carry on to Facebook.",
  approved: "Download your ads, then put them on Facebook.",
};

export function GalleryScreen({ stage, ads, pack, voice, approval, notice, figure, more }: GalleryScreenProps) {
  return (
    <PageFrame title={stage === "making" ? PAGE_TITLE : "Your ads are ready"} intro={INTRO[stage]}>
      {notice ? <Calm>{notice}</Calm> : null}

      <AdsGallery ads={ads} pack={pack} voice={voice} />

      {figure ? (
        <details className="rounded-2xl border border-border bg-card px-4 py-1">
          <summary className={`flex min-h-12 cursor-pointer items-center text-base font-semibold ${INK}`}>About the example in your ads</summary>
          <p className={`pb-3 text-base leading-relaxed ${INK}`}>{figure.sentence || figure.label}</p>
          <p className={`pb-3 text-base leading-relaxed ${SOFT}`}>It is always labelled as an example. We never promise what a landlord will earn.</p>
        </details>
      ) : null}

      {stage === "making" ? <Calm live={false}>When your video is ready, you can carry on to Facebook from here.</Calm> : null}

      {stage === "review" ? <LooksGood packId={pack.id} version={pack.version} approval={approval} /> : null}

      {stage === "approved" ? (
        <>
          <details className="rounded-2xl border border-border bg-card">
            <summary className={`flex min-h-14 cursor-pointer items-center px-4 py-3 text-lg font-semibold ${INK}`}>Download everything</summary>
            <div className="space-y-6 border-t border-border p-4">
              {ads.map((ad) => (
                <section key={ad.id} className="space-y-3">
                  <h3 className={`text-base font-bold ${INK}`}>{ad.heading}</h3>
                  {ad.downloads.map((g) => <DownloadRow key={g.key} adId={ad.id} group={g} noun={ad.video ? "video" : "picture"} />)}
                </section>
              ))}
            </div>
          </details>
          <StickyBar>
            <Link href={GUIDE_PATH} className={btnPrimary}>
              Put my ads on Facebook
            </Link>
          </StickyBar>
        </>
      ) : null}

      {more}
    </PageFrame>
  );
}
