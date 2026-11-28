import type { AdFiles } from "@/lib/ad-packs/store-types";
import type { AdsActions } from "@/app/leads/ads/ActionsContext";
import { adViewModel, areaPreviewView, voiceVm, type AdVm, type AreaPreviewView, type VoiceVm } from "@/app/leads/ads/view";

/**
 * Batch 38c: made-up data for the development preview. Nothing here is real: a
 * made-up company, pictures drawn on the spot, a one-second blank video. The ad
 * view models are built by the real adViewModel, so the screens show exactly
 * what the real page would build from stored files.
 */

export const COMPANY = "Brightstone Stays";
const COLOUR = "#1f6f5c";
const WEBM = "data:video/webm;base64,GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAL4EU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggEeTbuMU6uEHFO7a1OsggLi7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjAuMTYuMTAwV0GNTGF2ZjYwLjE2LjEwMESJiECPQAAAAAAAFlSua8GuAQAAAAAAADjXgQFzxYgY4HoaCWcqyZyBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhAX14QDgibCBWrqBoJqBAhJUw2f8c3OgY8CAZ8iaRaOHRU5DT0RFUkSHjUxhdmY2MC4xNi4xMDBzc9ZjwItjxYgY4HoaCWcqyWfIoUWjh0VOQ09ERVJEh5RMYXZjNjAuMzEuMTAyIGxpYnZweGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDEuMDAwMDAwMDAwAB9DtnVBPeeBAKPPgQAAgHAFAJ0BKloAoAAARwiFhYiFhIgCAgJ08kDoisghqqTXcQ6qk13EOqpNdxDqqTXcQ6qk120A/vxeZbKBPW//4M7//gzv/+DO/8EEAKOYgQBkABECAAEQEAAYABhYL/QACIVrYAAAo5iBAMgAEQIAARAQABgAGFgv9AAIhWtgAACjmIEBLAARAgABEBAAGAAYWC/0AAiFa2AAAKOYgQGQABECAAEQEAAYABhYL/QACIVrYAAAo5iBAfQAEQIAARAQABgAGFgv9AAIhWtgAACjmIECWAARAgABEBAAGAAYWC/0AAiFa2AAAKOXgQK8APEBAAEQEBRgAGFgv9AAIhWtgACjmIEDIAARAgABEBAAGAAYWC/0AAiFa2AAAKOYgQOEABECAAEQEAAYABhYL/QACIVrYAAAHFO7a5G7j7OBALeK94EB8YIBn/CBAw==";

const enc = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

function cardPicture(n: number, total: number, headline: string, line: string): string {
  return enc(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500"><rect width="400" height="500" fill="${COLOUR}"/><rect y="380" width="400" height="120" fill="#0f3b31"/><text x="30" y="80" font-family="Arial" font-size="22" fill="#cfe8df">${COMPANY}</text><text x="30" y="200" font-family="Arial" font-weight="700" font-size="44" fill="#fff">${headline}</text><text x="30" y="260" font-family="Arial" font-size="24" fill="#e6f3ee">${line}</text><text x="30" y="450" font-family="Arial" font-weight="700" font-size="26" fill="#fff">Find out more</text><text x="370" y="40" text-anchor="end" font-family="Arial" font-size="20" fill="#cfe8df">${n}/${total}</text></svg>`,
  );
}

const POSTER = enc(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 270 480"><rect width="270" height="480" fill="#13483c"/><text x="24" y="120" font-family="Arial" font-size="18" fill="#cfe8df">${COMPANY}</text><text x="24" y="240" font-family="Arial" font-weight="700" font-size="34" fill="#fff">Tenant given</text><text x="24" y="282" font-family="Arial" font-weight="700" font-size="34" fill="#fff">notice?</text></svg>`,
);

const SIZES = { "4x5": [1080, 1350], "9x16": [1080, 1920], "1x1": [1080, 1080] } as const;
const ref = (name: string, width: number, height: number) => ({ name, path: `owner/pack/v1/${name}`, width, height, contentType: name.endsWith(".png") ? "image/png" : "video/mp4", bytes: 1000 });

function pictureFiles(angle: string, count: number): AdFiles {
  const images = [];
  for (let n = 1; n <= count; n++) for (const [size, [w, h]] of Object.entries(SIZES)) images.push(ref(`${angle}-card${n}-${size}.png`, w, h));
  return { images, video: null };
}

const VIDEO_READY: AdFiles = {
  images: [],
  video: {
    status: "ready",
    voice: "jane",
    durationSeconds: 28,
    videos: [ref("notice-9x16.mp4", 1080, 1920), ref("notice-4x5.mp4", 1080, 1350), ref("notice-1x1.mp4", 1080, 1080)],
    poster: ref("notice-poster.png", 1080, 1920),
  },
};

function urlOf(path: string): string | null {
  if (path.endsWith(".mp4")) return WEBM;
  if (path.endsWith("notice-poster.png")) return POSTER;
  const m = /-card(\d+)-/.exec(path);
  const n = m ? Number(m[1]) : 1;
  return path.includes("/17-card")
    ? cardPicture(n, 4, ["Rules have", "changed", "Know where", "you stand"][n - 1] ?? "Rules", "A short guide for landlords")
    : cardPicture(n, 5, ["Moving abroad?", "Keep it let", "Someone local", "You stay owner", "Check yours"][n - 1] ?? "Abroad", "We look after it");
}

const TEXTS = {
  primary: [
    "Tenant handed in their notice? Before your agent relets, Brightstone Stays can run it as a short-term let, like an Airbnb. You stay the owner. Our management fee is 12%.",
    "Tenant just moved out? Before you sign the next one up for a year, see what a short-term let could take home. Brightstone Stays runs it all. You stay the owner.",
    "Between tenants in Nottingham? Guests stay a few nights, not a year. Brightstone Stays looks after the guests and the keys. You stay the owner.",
    "While your tenant works out their notice, find out what your property could take home as a short-term let. You stay the owner.",
    "Landlords: before another tenant, compare a short-term let, like an Airbnb. Brightstone Stays runs it, and you stay the owner.",
  ],
  headlines: ["Before your agent relets", "Tenant leaving? Check first", "Tenant gave notice?", "Another way to let it", "No tenancy to get stuck in"],
  descriptions: ["A short-term let with guests who stay days, not years.", "Answer a few quick questions. It takes a minute.", "Brightstone Stays runs it all, and you stay the owner.", "Check what your property could take home in a minute.", "See what a typical 3-bed in Nottingham could take home."],
};

export type VideoCase = "ready" | "making" | "failed-retry" | "failed-voice" | "failed-contact";

const LIVE = {
  ready: { status: "ready", code: null, poll: false, canRetry: false, message: null },
  making: { status: "making", code: null, poll: true, canRetry: false, message: null },
  "failed-retry": { status: "failed", code: "sandbox_failed", poll: false, canRetry: true, message: null },
  "failed-voice": { status: "failed", code: "voice_unavailable", poll: false, canRetry: false, message: null },
  "failed-contact": { status: "failed", code: "sandbox_failed", poll: false, canRetry: false, message: null },
} as const;

function ad(id: string, angle: "5b" | "3a" | "17", files: AdFiles, live: (typeof LIVE)[VideoCase] | null): AdVm {
  const code = angle.toUpperCase();
  return adViewModel(
    { id, angle, adName: `SI-3F9A2C-${code}-1 · ${angle === "5b" ? "Tenant notice" : angle === "3a" ? "Moving abroad" : "Renting rules changed"}`, link: `https://brightstonestays.co.uk/?ad=SI-3F9A2C-${code}-1&utm_source=facebook&utm_medium=paid_social&utm_campaign=SI-3F9A2C&utm_content={{ad.id}}`, texts: TEXTS, files },
    urlOf,
    live,
  );
}

/** The three ads, with the notice video in the given state (only a ready video has files). */
export function adsFor(video: VideoCase): AdVm[] {
  const live = LIVE[video];
  return [
    ad("ad-1", "5b", video === "ready" ? VIDEO_READY : { images: [], video: video === "making" ? { status: "making" } : { status: "failed", code: video === "failed-voice" ? "voice_unavailable" : "sandbox_failed" } }, live),
    ad("ad-2", "3a", pictureFiles("3a", 5), null),
    ad("ad-3", "17", pictureFiles("17", 4), null),
  ];
}

export const VOICE: VoiceVm = voiceVm({ key: "jane", changesLeft: 1, canChange: true, free: false, blocked: null });
export const VOICE_FREE: VoiceVm = voiceVm({ key: "oliver", changesLeft: 1, canChange: true, free: true, blocked: null });
export const VOICE_USED: VoiceVm = voiceVm({ key: "jane", changesLeft: 0, canChange: false, free: false, blocked: { code: "voice_limit_used", message: "x" } });

export const PACK = { id: "pack-1", version: 1 };

export const AREAS = [
  { areaKey: "NG7", label: "Nottingham (NG7)" },
  { areaKey: "NG", label: "Nottingham (all of NG)" },
  { areaKey: "LE2", label: "Leicester (LE2)" },
  { areaKey: "M14", label: "Manchester (M14)" },
];
export const AREA_PREVIEW: AreaPreviewView = areaPreviewView({ areaKey: "NG7", areaLabel: "Nottingham NG7", fellBack: false, bedrooms: 3, samples: 41 });

export const FIGURE = { label: "Example, not a promise", sentence: "A typical 3-bed in Nottingham NG7 took home about 1,350 a month in an average month. This is an example." };

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Pretend actions: they answer after a moment and change nothing. */
export const FAKE_ACTIONS: AdsActions = {
  generate: async () => {
    await wait(1200);
    return { error: "This is only a preview, so nothing was made." };
  },
  approve: async () => {
    await wait(600);
    return { error: "This is only a preview." };
  },
  changeVoice: async () => {
    await wait(600);
    return { error: "This is only a preview." };
  },
  retryVideo: async () => {
    await wait(600);
    return { error: "This is only a preview." };
  },
  poll: async () => ({ ok: true, version: 1, video: { state: "making", heading: "x", message: null, poll: true, action: "none" }, approval: { ok: false, message: "x" }, voice: VOICE }),
  videoUrl: async () => ({ ok: true, url: WEBM }),
  download: async (_adId, fileName) => ({ ok: true, url: `data:text/plain;charset=utf-8,${encodeURIComponent(`Preview of ${fileName}`)}` }),
  recordCopy: async () => undefined,
  uploadPhoto: async () => ({ ok: false, error: "This is only a preview." }),
  uploadBrandLogo: async () => ({ ok: false, error: "This is only a preview." }),
  areaPreview: async (areaKey) => areaPreviewView({ areaKey, areaLabel: AREAS.find((a) => a.areaKey === areaKey)?.label ?? areaKey, fellBack: false, bedrooms: 2, samples: 18 }),
};
