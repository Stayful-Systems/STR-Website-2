"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { VoiceKey } from "@/lib/ad-packs/voices";
import { useAdsActions } from "./ActionsContext";
import type { AdsState } from "./ops";
import { VoicePicker } from "./VoicePicker";
import { Alert, btnPrimary, btnSecondary, INK, SOFT, Spinner } from "./ui";
import { POLL_INTERVAL_MS, pollStep, VIDEO_FINISHING_TEXT, VIDEO_SLOW_TEXT, VOICE_CHANGE_BUTTON, VOICE_REMAKE_NOTE, type VideoFileVm, type VideoVm, type VoiceVm } from "./view";

/**
 * Batch 38c: the notice ad's video, in every state:
 *   being made   one calm panel. While the page is open it asks the server every few seconds (read only), loads the
 *                video once it is ready, and stops when the page is left and after about 15 minutes.
 *   ready        the video, to play
 *   failed       the plain message with the one right button: try again, or pick another voice, or get in touch
 * The page gives this a `key` that holds the state, so when the reloaded page brings a new state it starts afresh.
 * Every sentence comes from view.ts; every rule is enforced on the server.
 */

const INITIAL: AdsState = {};

// ── Being made: ask, then reload once ──

function Making({ packId, version, message }: { packId: string; version: number; message: string }) {
  const router = useRouter();
  const { poll: ask } = useAdsActions();
  const [phase, setPhase] = useState<"waiting" | "finishing" | "slow">("waiting");

  useEffect(() => {
    const startedMs = Date.now();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      if (stopped) return;
      let poll = true;
      let versionChanged = false;
      try {
        const out = await ask(packId);
        if (out.ok) {
          poll = out.video.poll;
          versionChanged = out.version !== version;
        }
      } catch {
        // A hiccup on the way: ask again next time.
      }
      if (stopped) return;
      const step = pollStep({ startedMs, nowMs: Date.now(), poll, versionChanged });
      if (step === "settled") {
        setPhase("finishing");
        router.refresh();
        return;
      }
      if (step === "give_up") {
        setPhase("slow");
        return;
      }
      timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };

    timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [packId, version, router, ask]);

  return (
    <div role="status" aria-live="polite" className="rounded-xl border border-border bg-white/70 p-4">
      <div className="flex items-center gap-3">
        {phase === "slow" ? null : <Spinner />}
        <p className={`text-base font-semibold ${INK}`}>{phase === "finishing" ? "Almost there" : "Making your video"}</p>
      </div>
      <p className={`mt-2 text-base leading-relaxed ${INK}`}>{phase === "slow" ? VIDEO_SLOW_TEXT : phase === "finishing" ? VIDEO_FINISHING_TEXT : message}</p>
      {phase === "slow" ? (
        <button type="button" className={`${btnSecondary} mt-3 w-full`} onClick={() => router.refresh()}>
          Check again
        </button>
      ) : (
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-[#3b5735]/15" aria-hidden>
          <div className="h-full w-1/3 animate-pulse rounded-full bg-[#3b5735]" />
        </div>
      )}
    </div>
  );
}

// ── Ready: the player ──

const MAX_LINK_REFRESHES = 2;

function VideoPlayer({ adId, file, poster, urls }: { adId: string; file: VideoFileVm; poster: string | null; urls: Record<string, string> }) {
  const { videoUrl } = useAdsActions();
  const [links, setLinks] = useState<Record<string, string>>(urls);
  const [failed, setFailed] = useState(false);
  const el = useRef<HTMLVideoElement>(null);
  const resumeAt = useRef(0);
  const refreshing = useRef(false);
  const refreshes = useRef(0);

  const url = links[file.name];
  const posterUrl = poster ? links[poster] : undefined;

  // The link lasts an hour. When it has run out, ask for a fresh one and carry on from where it stopped.
  async function refresh() {
    if (refreshing.current) return;
    if (refreshes.current >= MAX_LINK_REFRESHES) {
      setFailed(true);
      return;
    }
    refreshing.current = true;
    refreshes.current += 1;
    resumeAt.current = el.current?.currentTime ?? 0;
    try {
      const out = await videoUrl(adId, file.name);
      if (out.ok) {
        setLinks((prev) => ({ ...prev, [file.name]: out.url }));
        setFailed(false);
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    } finally {
      refreshing.current = false;
    }
  }

  const box = { aspectRatio: `${file.width} / ${file.height}` };
  return (
    <div className="mx-auto w-full max-w-[18rem]">
      {url && !failed ? (
        <video
          ref={el}
          src={url}
          poster={posterUrl}
          controls
          playsInline
          preload="metadata"
          aria-label="Your video"
          className="max-h-[75vh] w-full rounded-xl bg-black"
          style={box}
          onError={() => void refresh()}
          onLoadedMetadata={() => {
            refreshes.current = 0;
            if (el.current && resumeAt.current > 0) {
              el.current.currentTime = resumeAt.current;
              resumeAt.current = 0;
            }
          }}
        />
      ) : (
        <div className="flex items-center justify-center rounded-xl border-2 border-dashed border-border bg-white/60 p-4 text-center" style={box}>
          <div>
            <p className={`text-base ${INK}`}>We could not load the video just now.</p>
            <button type="button" className={`${btnSecondary} mt-3`} onClick={() => { refreshes.current = 0; void refresh(); }}>
              Try again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Failed ──

function RetryForm({ packId, version }: { packId: string; version: number }) {
  const { retryVideo } = useAdsActions();
  const [state, action, pending] = useActionState(retryVideo, INITIAL);
  return (
    <form action={action} className="mt-3 space-y-3">
      <input type="hidden" name="packId" value={packId} />
      <input type="hidden" name="version" value={version} />
      <button type="submit" disabled={pending} className={btnPrimary}>
        {pending ? "Starting…" : "Try again"}
      </button>
      {state.error ? <Alert>{state.error}</Alert> : null}
    </form>
  );
}

/** Pick a different voice and make the video again (before moving on to Facebook). */
export function ChangeVoiceForm({ packId, version, voice, note }: { packId: string; version: number; voice: VoiceVm; note?: string }) {
  const { changeVoice } = useAdsActions();
  const [state, action, pending] = useActionState(changeVoice, INITIAL);
  const [choice, setChoice] = useState<VoiceKey | "">("");
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="packId" value={packId} />
      <input type="hidden" name="version" value={version} />
      <p className={`text-base leading-relaxed ${SOFT}`}>{note ?? voice.note}</p>
      <VoicePicker name="voiceKey" value={choice} onChange={setChoice} current={voice.current} disabled={pending} />
      <p className={`text-base leading-relaxed ${SOFT}`}>{VOICE_REMAKE_NOTE}</p>
      <button type="submit" disabled={pending || choice === ""} className={btnPrimary}>
        {pending ? "Starting…" : VOICE_CHANGE_BUTTON}
      </button>
      {state.error ? <Alert>{state.error}</Alert> : null}
    </form>
  );
}

// ── The block ──

export interface VideoBlockProps {
  adId: string;
  packId: string;
  version: number;
  video: VideoVm;
  voice: VoiceVm;
}

export function VideoBlock({ adId, packId, version, video, voice }: VideoBlockProps) {
  const { card } = video;
  const main = video.files[0] ?? null;

  if (card.poll) return <Making packId={packId} version={version} message={card.message ?? ""} />;

  if (card.state === "ready" && main) return <VideoPlayer adId={adId} file={main} poster={video.poster} urls={video.urls} />;

  return (
    <div role={card.action === "change_voice" ? "status" : "alert"} className="rounded-xl border-2 border-border bg-white/70 p-4">
      <p className={`text-base font-semibold ${INK}`}>{card.heading}</p>
      {card.message ? <p className={`mt-2 text-base leading-relaxed ${INK}`}>{card.message}</p> : null}
      {card.action === "retry" ? <RetryForm packId={packId} version={version} /> : null}
      {card.action === "change_voice" && voice.canChange ? (
        <div className="mt-4">
          <ChangeVoiceForm packId={packId} version={version} voice={voice} />
        </div>
      ) : null}
    </div>
  );
}
