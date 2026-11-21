"use client";

import { AdsActionsProvider, type AdsActions } from "./ActionsContext";
import { approvePackAction, areaPreviewAction, changeVoiceAction, downloadFileAction, generatePackAction, pollPackAction, recordCopyAction, retryVideoAction, uploadPhotoAction, videoUrlAction } from "./actions";

/** The real server actions (each a few lines over ops.ts), handed to the screens below. The preview page hands them fake ones instead. */
const LIVE: AdsActions = {
  generate: generatePackAction,
  approve: approvePackAction,
  changeVoice: changeVoiceAction,
  retryVideo: retryVideoAction,
  poll: pollPackAction,
  videoUrl: videoUrlAction,
  download: downloadFileAction,
  recordCopy: recordCopyAction,
  uploadPhoto: uploadPhotoAction,
  areaPreview: areaPreviewAction,
};

export function LiveActions({ children }: { children: React.ReactNode }) {
  return <AdsActionsProvider actions={LIVE}>{children}</AdsActionsProvider>;
}
