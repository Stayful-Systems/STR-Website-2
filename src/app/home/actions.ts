"use server";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { logActivity } from "@/lib/activity/log";
import { revalidatePath } from "next/cache";
import { dismissPackOffer } from "@/lib/credit/pack-home-server";
import { dismissBlockerCard } from "@/lib/home/blocker-card-server";
import { answerQuestion } from "@/lib/profile/server";
import { ABOUT_OPTIONS } from "@/lib/profile/about";

/** What a Home tap may name: a tile (`tile:<name>`) or a "This week" line (`feed:<kind>`). Anything else is dropped. */
const TARGET = /^(tile|feed):[a-z_]{1,24}$/;

/**
 * Batch 22e: a tap on a Home tile or a "This week" line. Record only (it
 * never counts towards weekly active): the page it opens logs its own view.
 * Whose tap is always the session's.
 */
export async function logHomeTapAction(target: string): Promise<void> {
  if (typeof target !== "string" || !TARGET.test(target)) return;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;
  logActivity(user.id, target.startsWith("feed:") ? "home_feed_tap" : "home_tile_tap", { extras: { target } });
}

/** Batch 29: "Not now" on Home's starter pack offer card. The session's own member only. */
export async function dismissPackOfferAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;
  await dismissPackOffer(user.id);
  revalidatePath("/home");
}

/**
 * Batch 30: one tap on Home's "What's holding you back?" card answers the quiz's own question (a
 * profile_answered, saved as them). The value is checked against the closed list; whose answer is the session's.
 */
export async function answerBlockerCardAction(value: string): Promise<{ ok: boolean }> {
  if (typeof value !== "string" || !(ABOUT_OPTIONS.blocker as readonly string[]).includes(value)) return { ok: false };
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false };
  const r = await answerQuestion({ userId: user.id, email: user.email ?? null, supabase, questionId: "blocker", value, notSure: false, editing: false });
  revalidatePath("/home");
  return { ok: r.ok };
}

/** Batch 30: "Not now" on the card: stamped once, record-only activity. */
export async function dismissBlockerCardAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;
  await dismissBlockerCard(user.id);
  logActivity(user.id, "home_blocker_dismissed", { dedupeKey: "home_blocker_dismissed" });
  revalidatePath("/home");
}
