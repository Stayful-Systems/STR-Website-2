"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import type { VoiceKey } from "@/lib/ad-packs/voices";
import { changeVoiceAction, pollPackAction, retryVideoAction, videoUrlAction } from "./actions";
import type { AdsState } from "./ops";
import { DownloadButton } from "./AdPackClient";
import { VoiceCards } from "./VoiceCards";
import { POLL_INTERVAL_MS, pollStep, VIDEO_SLOW_TEXT, VOICE_CHANGE_TITLE, VOICE_REMAKE_NOTE, type VideoFileVm, type VideoVm, type VoiceVm } from "./view";

/**
 * Batch 38b: the notice ad's video on the ad pack screen, in every state:
 *   making     a plain message and a small progress bar. This asks the server every few seconds (pollPackAction,
 *              read only), reloads the page once the video has settled, and stops when the page is left and after
 *              about 15 minutes, with a plain "taking longer than usual".
 *   ready      a player with a choice of size, and (once approved) the three downloads
 *   failed     the plain message with the right button: Try again, or Change voice (free), or "contact support"
 *   a voice change before approving (the three voices again, with their sample clips)
 * The page gives this component a `key` that holds the state and the version, so when the reloaded page brings
 * a different state this starts afresh. Every sentence comes from view.ts; every rule is enforced on the server.
 */

const INITIAL: AdsState = {};

function Alert({ children }: { children: React.ReactNode }) {
  return <p role="alert" className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{children}</p>;
}

// ── Making: poll, then reload once ──

function Making({ packId, version }: { packId: string; version: number }) {
  const router = useRouter();
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
        const out = await pollPackAction(packId);
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
  }, [packId, version, router]);

  return (
    <div role="status" aria-live="polite" className="rounded-lg border border-border bg-muted/40 p-4">
      <p className="text-sm text-foreground">{phase === "slow" ? VIDEO_SLOW_TEXT : phase === "finishing" ? "Your video has changed. Loading it now…" : "Making your video… this usually takes 3 to 6 minutes. You can leave this page and come back."}</p>
      {phase !== "slow" ? (
        <div className="mt-3 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
        </div>
      ) : (
        <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => router.refresh()}>Check again</Button>
      )}
    </div>
  );
}

// ── Ready: the player ──

const MAX_LINK_REFRESHES = 2;

function VideoPlayer({ adId, files, poster, urls, seconds, voiceLabel }: { adId: string; files: VideoFileVm[]; poster: string | null; urls: Record<string, string>; seconds: number | null; voiceLabel: string | null }) {
  const [name, setName] = useState(files[0]?.name ?? "");
  const [links, setLinks] = useState<Record<string, string>>(urls);
  const [failed, setFailed] = useState(false);
  const el = useRef<HTMLVideoElement>(null);
  const resumeAt = useRef(0);
  const refreshing = useRef(false);
  const refreshes = useRef(0);

  const file = files.find((f) => f.name === name) ?? files[0];
  if (!file) return null;
  const url = links[file.name];
  const posterUrl = file.ratio === "9:16" && poster ? links[poster] : undefined;

  // The link lasts an hour. When it has run out, ask for a fresh one and carry on from where it stopped.
  async function refresh() {
    if (!file || refreshing.current) return;
    if (refreshes.current >= MAX_LINK_REFRESHES) {
      setFailed(true);
      return;
    }
    refreshing.current = true;
    refreshes.current += 1;
    resumeAt.current = el.current?.currentTime ?? 0;
    try {
      const out = await videoUrlAction(adId, file.name);
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

  function pick(next: string) {
    setName(next);
    setFailed(false);
    refreshes.current = 0;
    resumeAt.current = 0;
  }

  return (
    <div>
      <div className={file.ratio === "9:16" ? "max-w-[18rem]" : "max-w-md"}>
        {url && !failed ? (
          <video
            key={file.name}
            ref={el}
            src={url}
            poster={posterUrl}
            controls
            playsInline
            preload="metadata"
            aria-label={`Your video, ${file.label}`}
            className="max-h-[70vh] w-full rounded-lg bg-black"
            style={{ aspectRatio: `${file.width} / ${file.height}` }}
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
          <div className="flex items-center justify-center rounded-lg border border-dashed border-border bg-muted/40 p-4 text-center" style={{ aspectRatio: `${file.width} / ${file.height}` }}>
            <div>
              <p className="text-sm text-muted-foreground">We could not load the video just now.</p>
              <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => { refreshes.current = 0; void refresh(); }}>Try again</Button>
            </div>
          </div>
        )}
      </div>
      {files.length > 1 ? (
        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Choose a video size">
          {files.map((f) => (
            <Button key={f.name} type="button" size="sm" variant={f.name === file.name ? "default" : "outline"} aria-pressed={f.name === file.name} onClick={() => pick(f.name)}>
              {f.label}
            </Button>
          ))}
        </div>
      ) : null}
      <p className="mt-2 text-xs text-muted-foreground">
        {voiceLabel ? `Voice: ${voiceLabel}. ` : ""}
        {seconds ? `About ${seconds} seconds. ` : ""}
        The words are on the screen, so it works with the sound off.
      </p>
    </div>
  );
}

// ── Failed: try again ──

function RetryForm({ packId, version }: { packId: string; version: number }) {
  const [state, action, pending] = useActionState(retryVideoAction, INITIAL);
  return (
    <form action={action} className="mt-3">
      <input type="hidden" name="packId" value={packId} />
      <input type="hidden" name="version" value={version} />
      <Button type="submit" disabled={pending}>{pending ? "Starting…" : "Try again"}</Button>
      {state.error ? <Alert>{state.error}</Alert> : null}
    </form>
  );
}

// ── Change the voice, before approving ──

function ChangeVoice({ packId, version, voice, open, unavailable }: { packId: string; version: number; voice: VoiceVm; open: boolean; unavailable: boolean }) {
  const [state, action, pending] = useActionState(changeVoiceAction, INITIAL);
  const [choice, setChoice] = useState<VoiceKey | "">("");

  return (
    <details open={open} className="rounded-lg border border-border p-4">
      <summary className="cursor-pointer text-sm font-medium text-foreground">{VOICE_CHANGE_TITLE}</summary>
      <form action={action} className="mt-3 space-y-3">
        <input type="hidden" name="packId" value={packId} />
        <input type="hidden" name="version" value={version} />
        <p className="text-sm text-muted-foreground">{voice.note} {VOICE_REMAKE_NOTE}</p>
        <VoiceCards name="voiceKey" value={choice} onChange={setChoice} current={voice.current} currentNote={unavailable ? "This voice isn't available yet" : "Your video has this voice now"} disabled={pending} />
        <Button type="submit" disabled={pending || choice === ""}>{pending ? "Starting…" : "Use this voice and remake my video"}</Button>
        {state.error ? <Alert>{state.error}</Alert> : null}
      </form>
    </details>
  );
}

// ── The section ──

export interface VideoSectionProps {
  adId: string;
  packId: string;
  version: number;
  approved: boolean;
  video: VideoVm;
  voice: VoiceVm;
}

export function VideoSection({ adId, packId, version, approved, video, voice }: VideoSectionProps) {
  const { card } = video;
  const needsVoice = card.action === "change_voice";
  const showChange = !approved && (card.state === "ready" || needsVoice) && voice.canChange;
  return (
    <div className="mt-4 space-y-4">
      {card.poll ? <Making packId={packId} version={version} /> : null}

      {card.state === "ready" && video.files.length > 0 ? <VideoPlayer adId={adId} files={video.files} poster={video.poster} urls={video.urls} seconds={video.seconds} voiceLabel={voice.currentLabel} /> : null}

      {card.state === "failed" || card.state === "coming" ? (
        <div role={needsVoice ? "status" : "alert"} className={`rounded-lg border p-4 ${needsVoice ? "border-border bg-muted/40" : "border-destructive/40 bg-destructive/10"}`}>
          <p className="text-sm font-medium text-foreground">{card.heading}</p>
          {card.message ? <p className="mt-1 text-sm text-foreground">{card.message}</p> : null}
          {card.action === "retry" ? <RetryForm packId={packId} version={version} /> : null}
        </div>
      ) : null}

      {approved && card.state === "ready" ? (
        <div>
          <p className="text-xs font-medium text-muted-foreground">Download the video for each placement</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {video.files.map((f) => <DownloadButton key={f.name} adId={adId} fileName={f.name} label={f.label} />)}
          </div>
        </div>
      ) : null}

      {showChange ? <ChangeVoice packId={packId} version={version} voice={voice} open={needsVoice} unavailable={needsVoice} /> : null}
      {!approved && !voice.canChange && card.state === "ready" && voice.blocked ? <p className="text-xs text-muted-foreground">{voice.blocked}</p> : null}
    </div>
  );
}
