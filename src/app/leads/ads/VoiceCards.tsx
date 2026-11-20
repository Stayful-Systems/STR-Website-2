"use client";

import { useRef } from "react";
import type { VoiceKey } from "@/lib/ad-packs/voices";
import { voiceCards } from "./view";

/**
 * Batch 38b: the three voices as cards, each with its free sample clip so the
 * operator listens BEFORE choosing. Used to pick the voice before Generate, and
 * again to change it before approving. A native audio player on the https
 * sample clip (no script, nothing to install); one clip plays at a time. The
 * choice is a radio group posted as `voiceKey`.
 */

export interface VoiceCardsProps {
  /** The form field name the choice is posted under. */
  name: string;
  value: VoiceKey | "";
  onChange: (key: VoiceKey) => void;
  /** The voice the video has now (change step): marked, and not offered again. */
  current?: VoiceKey | null;
  /** Said under the marked voice, e.g. when it could not be used. */
  currentNote?: string;
  disabled?: boolean;
}

const CARDS = voiceCards();

export function VoiceCards({ name, value, onChange, current = null, currentNote = "Your video has this voice now", disabled = false }: VoiceCardsProps) {
  const players = useRef(new Map<string, HTMLAudioElement>());

  // One sample at a time: starting one stops the others.
  function stopOthers(key: string) {
    for (const [k, el] of players.current) if (k !== key && !el.paused) el.pause();
  }

  return (
    <div role="radiogroup" aria-label="Voice for your video" className="grid gap-3 sm:grid-cols-3">
      {CARDS.map((v) => {
        const isCurrent = current === v.key;
        const selected = value === v.key;
        return (
          <div key={v.key} className={`flex min-w-0 flex-col rounded-lg border p-3 ${selected ? "border-primary bg-primary/5" : "border-border"} ${isCurrent ? "opacity-80" : ""}`}>
            <label className={`flex items-start gap-2 ${isCurrent || disabled ? "" : "cursor-pointer"}`}>
              <input
                type="radio"
                name={name}
                value={v.key}
                checked={selected}
                disabled={disabled || isCurrent}
                onChange={() => onChange(v.key)}
                className="mt-1 size-4"
              />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-foreground">{v.label}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{v.description}</span>
                {isCurrent ? <span className="mt-1 block text-xs font-medium text-foreground">{currentNote}</span> : null}
              </span>
            </label>
            <audio
              controls
              preload="none"
              src={v.previewUrl}
              aria-label={`Hear ${v.label}`}
              className="mt-3 h-10 w-full"
              ref={(el) => {
                if (el) players.current.set(v.key, el);
                else players.current.delete(v.key);
              }}
              onPlay={() => stopOthers(v.key)}
            />
          </div>
        );
      })}
    </div>
  );
}
