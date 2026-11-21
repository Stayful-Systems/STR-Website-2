"use client";

import { useState } from "react";
import { useAdsActions } from "./ActionsContext";
import type { DownloadGroup } from "./view";
import { Alert, btnSecondary, INK, SOFT } from "./ui";

/**
 * Batch 38c: downloads. One tap saves every file of one size (the whole set of
 * pictures of a picture ad, or the one video file). The links are made on tap
 * by an action that checks each file is the owner's (ops.ts downloadOp); the
 * browser then saves the files one after the other.
 */

type Phase = "idle" | "busy" | "saved" | "failed";

const GAP_MS = 450;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function save(url: string, fileName: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/** Fetch every link first, then save the files a moment apart, so the browser counts it as one tap. */
function useSaveFiles(adId: string) {
  const { download } = useAdsActions();
  const [phase, setPhase] = useState<Phase>("idle");

  async function run(fileNames: readonly string[]) {
    setPhase("busy");
    try {
      const links = await Promise.all(fileNames.map((name) => download(adId, name)));
      const ok = links.flatMap((l, i) => (l.ok ? [{ url: l.url, name: fileNames[i] }] : []));
      if (ok.length === 0) {
        setPhase("failed");
        return;
      }
      for (let i = 0; i < ok.length; i++) {
        if (i > 0) await pause(GAP_MS);
        save(ok[i].url, ok[i].name);
      }
      setPhase(ok.length < fileNames.length ? "failed" : "saved");
    } catch {
      setPhase("failed");
    }
  }

  return { phase, run };
}

/** One size, one button. `big` makes the recommended one stand out. */
export function DownloadRow({ adId, group, noun, big = false }: { adId: string; group: DownloadGroup; noun: string; big?: boolean }) {
  const { phase, run } = useSaveFiles(adId);
  const count = group.files.length;
  const what = count > 1 ? `all ${count} ${noun}s` : `the ${noun}`;
  return (
    <div>
      <button
        type="button"
        disabled={phase === "busy"}
        onClick={() => void run(group.files)}
        className={`${btnSecondary} w-full flex-col items-start gap-0.5 text-left ${big ? "bg-white" : ""}`}
      >
        <span className="block text-base font-semibold">
          {phase === "busy" ? "Getting your files…" : `Download ${what}: ${group.label}`}
        </span>
        <span className={`block text-base font-normal ${SOFT}`}>{group.hint}</span>
      </button>
      {phase === "saved" ? (
        <p role="status" className={`mt-2 text-base ${INK}`}>
          Saved. Look in your downloads or photos.
        </p>
      ) : null}
      {phase === "failed" ? (
        <div className="mt-2">
          <Alert>We could not get all of your files. Please try again.</Alert>
        </div>
      ) : null}
    </div>
  );
}

/** One "Download" button that opens the list of sizes right under it. */
export function DownloadMenu({ adId, groups, noun }: { adId: string; groups: DownloadGroup[]; noun: string }) {
  const [open, setOpen] = useState(false);
  if (groups.length === 0) return null;
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={`${btnSecondary} w-full`}>
        Download
        <span aria-hidden>{open ? "▲" : "▼"}</span>
      </button>
      {open ? (
        <div className="mt-3 space-y-3">
          {groups.map((g, i) => (
            <DownloadRow key={g.key} adId={adId} group={g} noun={noun} big={i === 0} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
