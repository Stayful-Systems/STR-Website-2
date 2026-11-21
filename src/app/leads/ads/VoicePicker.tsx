"use client";

import { useRef, useState } from "react";
import type { VoiceKey } from "@/lib/ad-packs/voices";
import { voiceCards } from "./view";
import { INK, SOFT } from "./ui";

/**
 * Batch 38c: the three voices as compact cards. Tap the card to pick the voice;
 * tap the round play button to hear a free sample first. One sample plays at a
 * time, on one hidden audio element that only loads when asked. The choice is a
 * radio group posted as `voiceKey`.
 */

export interface VoicePickerProps {
  /** The form field name the choice is posted under. */
  name: string;
  value: VoiceKey | "";
  onChange: (key: VoiceKey) => void;
  /** The voice the video has now (when changing it): marked, and not offered again. */
  current?: VoiceKey | null;
  disabled?: boolean;
}

const CARDS = voiceCards();

function PlayIcon({ playing }: { playing: boolean }) {
  return playing ? (
    <svg aria-hidden viewBox="0 0 24 24" className="size-6" fill="currentColor">
      <rect x="6" y="5" width="4.5" height="14" rx="1" />
      <rect x="13.5" y="5" width="4.5" height="14" rx="1" />
    </svg>
  ) : (
    <svg aria-hidden viewBox="0 0 24 24" className="size-6" fill="currentColor">
      <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" />
    </svg>
  );
}

export function VoicePicker({ name, value, onChange, current = null, disabled = false }: VoicePickerProps) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState<VoiceKey | null>(null);
  const [trouble, setTrouble] = useState(false);

  function toggle(key: VoiceKey, url: string) {
    const el = audio.current;
    if (!el) return;
    setTrouble(false);
    if (playing === key) {
      el.pause();
      setPlaying(null);
      return;
    }
    el.pause();
    el.src = url;
    setPlaying(key);
    el.play().catch(() => {
      setPlaying(null);
      setTrouble(true);
    });
  }

  return (
    <div>
      <div role="radiogroup" aria-label="Voice for your video" className="space-y-3">
        {CARDS.map((v) => {
          const isCurrent = current === v.key;
          const selected = value === v.key;
          return (
            <div key={v.key} className="flex items-stretch gap-2">
              <label className="relative min-w-0 flex-1">
                <input type="radio" name={name} value={v.key} checked={selected} disabled={disabled || isCurrent} onChange={() => onChange(v.key)} className="peer sr-only" />
                <span
                  className={`flex min-h-16 items-center gap-3 rounded-xl border-2 p-3 transition peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[#233221] ${
                    selected ? "border-[#3b5735] bg-white" : "border-border bg-card"
                  } ${isCurrent ? "opacity-70" : "cursor-pointer"}`}
                >
                  <span aria-hidden className={`flex size-6 shrink-0 items-center justify-center rounded-full border-2 ${selected ? "border-[#3b5735] bg-[#3b5735]" : "border-[#46603f]/60 bg-white"}`}>
                    {selected ? <span className="size-2 rounded-full bg-white" /> : null}
                  </span>
                  <span className="min-w-0">
                    <span className={`block text-base font-semibold ${INK}`}>{v.label}</span>
                    <span className={`block text-base leading-snug ${SOFT}`}>{isCurrent ? "Your video has this voice now" : v.description}</span>
                  </span>
                </span>
              </label>
              <button
                type="button"
                onClick={() => toggle(v.key, v.previewUrl)}
                aria-label={playing === v.key ? `Stop ${v.label}` : `Hear ${v.label}`}
                aria-pressed={playing === v.key}
                className="flex w-14 shrink-0 items-center justify-center rounded-xl border-2 border-[#3b5735]/50 bg-card text-[#2c4727] transition active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#233221]"
              >
                <PlayIcon playing={playing === v.key} />
              </button>
            </div>
          );
        })}
      </div>
      <audio ref={audio} preload="none" className="hidden" onEnded={() => setPlaying(null)} onPause={(e) => { if (e.currentTarget.paused) setPlaying(null); }} />
      {trouble ? (
        <p role="status" className={`mt-2 text-base ${INK}`}>
          We could not play that sample. Please try again.
        </p>
      ) : null}
    </div>
  );
}
