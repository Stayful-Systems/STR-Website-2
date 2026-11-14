"use server";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { logActivity } from "@/lib/activity/log";
import { revalidatePath } from "next/cache";
import { dismissPackOffer } from "@/lib/credit/pack-home-server";

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
