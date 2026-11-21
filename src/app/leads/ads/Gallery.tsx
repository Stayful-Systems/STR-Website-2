"use client";

import { useRef, useState } from "react";
import { DownloadMenu } from "./Downloads";
import { VideoBlock } from "./VideoBlock";
import { INK, SOFT } from "./ui";
import type { AdCardVm, AdVm, VoiceVm } from "./view";

/**
 * Batch 38c: the three ads, one card each: its name, the picture or the video,
 * and a Download button. A picture ad is a set of pictures people swipe through:
 * the strip scrolls sideways one picture at a time (on a phone it is a swipe) and
 * the dots under it jump to a picture. The video card says when the video is
 * still being made and updates itself. On a phone the cards stack; on a wide
 * screen they sit side by side.
 */

function PictureStrip({ ad, cards }: { ad: AdVm; cards: AdCardVm[] }) {
  const strip = useRef<HTMLUListElement>(null);
  const [at, setAt] = useState(0);

  function onScroll() {
    const el = strip.current;
    if (!el || el.clientWidth === 0) return;
    setAt(Math.max(0, Math.min(cards.length - 1, Math.round(el.scrollLeft / el.clientWidth))));
  }

  function jump(i: number) {
    const el = strip.current;
    if (!el) return;
    el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" });
    setAt(i);
  }

  return (
    <div>
      <ul
        ref={strip}
        onScroll={onScroll}
        tabIndex={0}
        aria-label={`The ${cards.length} pictures of ${ad.heading}. Swipe sideways to see them all.`}
        className="flex snap-x snap-mandatory overflow-x-auto rounded-xl bg-white/50 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {cards.map((c) => (
          <li key={c.card} className="w-full shrink-0 snap-center">
            {c.previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- a private picture behind a signed link: never through the image optimiser, which would cache it publicly
              <img src={c.previewUrl} alt={`Picture ${c.card} of ${cards.length}`} className="aspect-[4/5] w-full rounded-xl border border-border object-cover" loading="lazy" draggable={false} />
            ) : (
              <div className={`flex aspect-[4/5] w-full items-center justify-center rounded-xl border-2 border-dashed border-border p-3 text-center text-base ${SOFT}`}>Picture {c.card}</div>
            )}
          </li>
        ))}
      </ul>
      {cards.length > 1 ? (
        <div className="mt-2 flex items-center justify-center" role="group" aria-label="Pictures">
          {cards.map((c, i) => (
            <button key={c.card} type="button" onClick={() => jump(i)} aria-label={`Show picture ${c.card}`} aria-current={i === at} className="flex size-11 items-center justify-center">
              <span className={`block rounded-full transition-all ${i === at ? "size-3.5 bg-[#3b5735]" : "size-2.5 bg-[#3b5735]/35"}`} />
            </button>
          ))}
        </div>
      ) : null}
      {cards.length > 1 ? <p className={`text-center text-base ${SOFT}`}>Picture {at + 1} of {cards.length}. Swipe to see the rest.</p> : null}
    </div>
  );
}

export function AdCard({ ad, pack, voice }: { ad: AdVm; pack: { id: string; version: number }; voice: VoiceVm }) {
  const isVideo = ad.video !== null;
  return (
    <section aria-label={ad.heading} className="flex min-w-0 flex-col gap-4 rounded-2xl border border-border bg-card p-4">
      <header>
        <h2 className={`text-xl font-bold leading-snug ${INK}`}>{ad.heading}</h2>
        <p className={`mt-1 text-base leading-snug ${SOFT}`}>{ad.blurb}</p>
      </header>

      {ad.video ? (
        // The key holds the state, the version and the voice: when the reloaded page brings a different one (the video is ready, the voice was changed) this starts afresh.
        <VideoBlock key={`${ad.video.card.state}:${pack.version}:${voice.current ?? ""}`} adId={ad.id} packId={pack.id} version={pack.version} video={ad.video} voice={voice} />
      ) : ad.cards.length > 0 ? (
        <PictureStrip ad={ad} cards={ad.cards} />
      ) : null}

      <div className="mt-auto">
        <DownloadMenu adId={ad.id} groups={ad.downloads} noun={isVideo ? "video" : "picture"} />
      </div>
    </section>
  );
}

export function AdsGallery({ ads, pack, voice }: { ads: AdVm[]; pack: { id: string; version: number }; voice: VoiceVm }) {
  return (
    <div className="grid gap-5 md:grid-cols-3">
      {ads.map((ad) => (
        <AdCard key={ad.id} ad={ad} pack={pack} voice={voice} />
      ))}
    </div>
  );
}
