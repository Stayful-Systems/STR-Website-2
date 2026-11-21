"use client";

import { createContext, useContext } from "react";
import type { AdsState, DownloadState, PollState, UploadState } from "./ops";
import type { AreaPreviewView } from "./view";

/**
 * Batch 38c: the screens never import the server actions themselves. They ask
 * this context for them, so the very same components run on the real page (the
 * actions come from LiveActions.tsx, each a thin wrapper over ops.ts) and in
 * the development preview (fake actions, no database). Every rule about who may
 * do what stays in ops.ts: this file only carries functions.
 */

type FormAction = (prev: AdsState, formData: FormData) => Promise<AdsState>;

export interface AdsActions {
  /** "Make my ads" (and "make new ads"). */
  generate: FormAction;
  /** "Looks good": the pack id and the version on screen are in the form. */
  approve: FormAction;
  changeVoice: FormAction;
  retryVideo: FormAction;
  /** Read only: asked every few seconds while the video is made. */
  poll(packId: string): Promise<PollState>;
  /** A fresh one-hour view link for the player. */
  videoUrl(adId: string, fileName: string): Promise<DownloadState>;
  /** A short download link for one file. */
  download(adId: string, fileName: string): Promise<DownloadState>;
  /** Logs that a text was copied (the kind and the position, never the text). */
  recordCopy(adId: string, kind: string, index: number): Promise<void>;
  uploadPhoto(formData: FormData): Promise<UploadState>;
  areaPreview(areaKey: string): Promise<AreaPreviewView>;
}

const Ctx = createContext<AdsActions | null>(null);

export function AdsActionsProvider({ actions, children }: { actions: AdsActions; children: React.ReactNode }) {
  return <Ctx.Provider value={actions}>{children}</Ctx.Provider>;
}

export function useAdsActions(): AdsActions {
  const a = useContext(Ctx);
  if (!a) throw new Error("AdsActionsProvider is missing");
  return a;
}
