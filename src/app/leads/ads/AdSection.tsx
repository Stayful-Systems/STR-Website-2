import { AdTexts, DownloadButton } from "./AdPackClient";
import type { AdVm } from "./view";

/**
 * Batch 38 (Phase 8): one ad of the pack. A server component: the image
 * previews are signed links the page made for this owner's own files. In a
 * preview the texts are listed; once approved each has a Copy button and every
 * image file can be downloaded (the download links are made on tap, by an
 * action that checks the ad is the owner's).
 */
export function AdSection({ ad, approved }: { ad: AdVm; approved: boolean }) {
  return (
    <section className="rounded-xl border border-border bg-card p-4 sm:p-5" aria-label={ad.title}>
      <header>
        <h3 className="text-base font-semibold text-foreground">{ad.title}</h3>
        <p className="mt-0.5 break-all text-xs text-muted-foreground">{ad.adName}</p>
      </header>

      {ad.videoText ? (
        <div className="mt-4 flex aspect-video max-w-md flex-col items-center justify-center rounded-lg border border-dashed border-border bg-muted/40 p-4 text-center">
          <p className="text-sm font-medium text-foreground">{ad.videoText}</p>
          <p className="mt-1 text-xs text-muted-foreground">The texts, name and link for this ad are ready below.</p>
        </div>
      ) : null}

      {ad.cards.length > 0 ? (
        <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {ad.cards.map((c) => (
            <li key={c.card} className="min-w-0">
              {c.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- a private image behind a signed link: never through the image optimiser, which would cache it publicly
                <img src={c.previewUrl} alt={`Image ${c.card} of your ${ad.title} ad`} className="aspect-[4/5] w-full rounded-md border border-border object-cover" loading="lazy" />
              ) : (
                <div className="flex aspect-[4/5] w-full items-center justify-center rounded-md border border-dashed border-border bg-muted/40 p-2 text-center text-xs text-muted-foreground">Image {c.card}</div>
              )}
              <p className="mt-1 text-xs font-medium text-foreground">Image {c.card}</p>
              {approved ? (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {c.files.map((f) => <DownloadButton key={f.name} adId={ad.id} fileName={f.name} label={f.size} />)}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-5 border-t border-border pt-4">
        <AdTexts adId={ad.id} copy={ad.copy} canCopy={approved} />
      </div>
    </section>
  );
}
