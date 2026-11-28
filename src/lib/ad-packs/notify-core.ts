/**
 * Batch 38b: tell the operator when their video ad is finished or has failed. The video takes minutes and the screen
 * may be closed by then, so the worker sends ONE email per result.
 *
 *   notifyVideoOutcomes(deps)   one sweep, called by the render worker before and after it renders (never throws)
 *
 * WHAT IS SENT, and when (a finished render nobody has been told about, finished in the last 30 minutes):
 *   done    and the version is now approvable (approvalBlock is null: the pack is in 'preview' on this version, its
 *           checks pass, the video check ran and passed, the video is ready)      ->  "Your video ad is ready"
 *   done    but the pack went to 'checks_failed' (the video failed its checks)     ->  "We couldn't finish your video"
 *   failed  for good (the row is `failed`: no more tries) on the pack's current version, in 'preview' or
 *           'checks_failed'                                                        ->  "We couldn't finish your video"
 *   anything else (a superseded render, a pack that moved on or is gone, no address on the account) is recorded as
 *   'skipped': nothing is sent and it is not looked at again.
 * A render that goes back to `queued` for another try is not finished, so nothing is sent for it.
 *
 * ONCE, ATOMICALLY. The send is claimed first by one conditional update (notified_at is null and the row is still in
 * the state judged): the claim sets notified_at and notified_outcome, and only the pass that wins it sends. A repeated
 * cron tick, or two passes at once, finds nothing to claim. The idempotency key of the email is the render, the outcome
 * and the moment it finished, so even a second send of the same result is not delivered twice. A voice change or an
 * operator's retry re-queues the same row and clears both fields (requeueRender), so the next result emails again.
 *
 * A SEND THAT FAILS never fails the render: the claim is given back (notified_at null again) and the next tick, five
 * minutes later, tries again, for as long as the render finished within the window (so a few tries at most).
 *
 * THE ADDRESS comes from the pack owner's profile, on the server, through `deps.notify.ownerEmail`. It and the body
 * are never logged: a log line carries a pack id and a code.
 *
 * Pure: everything outside it is injected (the store, the pack store, the profile lookup and the mailer).
 */
import { approvalBlock } from './generate-core.ts';
import type { AdPackStore, PackRow } from './store-types.ts';
import type { NotifyOutcome, RenderRow, RenderStore } from './render-store.ts';
import { kindOf } from './render-store.ts';
import { videoEmailKey, type VideoEmailOutcome } from '../email/ad-pack-video.ts';

/** How long after a render finished its email is still tried (bounds the tries of a send that keeps failing). */
export const NOTIFY_WINDOW_MINUTES = 30;
/** Renders looked at per sweep. */
export const NOTIFY_BATCH = 5;

export type VideoNotifyDeps = {
  /** The pack owner's login email from their profile (server side), or null when there is none. May throw: the row is left for the next tick. */
  ownerEmail: (ownerId: string) => Promise<string | null>;
  /** Send one email; `sent` is true when it went (or Resend already had it). Never throws. */
  send: (to: string, o: { outcome: VideoEmailOutcome; errorCode: string | null; idempotencyKey: string }) => Promise<{ sent: boolean }>;
};

export type NotifyDeps = {
  renders: Pick<RenderStore, 'listUnnotified' | 'claimNotify' | 'releaseNotify' | 'getPack'>;
  packs: Pick<AdPackStore, 'listAds'>;
  notify?: VideoNotifyDeps;
  now: () => Date;
  log?: (event: string, fields: { packId?: string; code?: string }) => void;
};

export type NotifyReport = { sent: number; failed: number; skipped: number };

type Decision = { outcome: NotifyOutcome; email: boolean };

/** What a finished render's email is, from the row and the pack as they are now. */
export async function decideVideoEmail(deps: Pick<NotifyDeps, 'packs'>, row: RenderRow, pack: PackRow | null): Promise<Decision> {
  const skip: Decision = { outcome: 'skipped', email: false };
  if (!pack || pack.id !== row.packId || pack.version !== row.version) return skip;
  // Batch 55 step 5: ONE email, for the 5b video (notice or phone). The example report and the loupe video send none.
  const kind = kindOf(row);
  if (kind === 'example_report' || kind === 'loupe') return skip;
  if (row.state === 'done') {
    const ads = await deps.packs.listAds(pack.ownerId, pack.id);
    const slot = ads.find((a) => a.angle === '5b' && a.version === row.version)?.files.video ?? null;
    if (approvalBlock(pack, slot, row) === null) return { outcome: 'ready', email: true };
    // The video was made but failed its checks: the operator cannot approve it, so they are told it did not come out.
    if (pack.status === 'checks_failed') return { outcome: 'failed', email: true };
    return skip;
  }
  if (row.state === 'failed') {
    if (row.errorCode === 'superseded') return skip;
    if (pack.status !== 'preview' && pack.status !== 'checks_failed') return skip;
    return { outcome: 'failed', email: true };
  }
  return skip;
}

/** One sweep. Never throws. */
export async function notifyVideoOutcomes(deps: NotifyDeps): Promise<NotifyReport> {
  const report: NotifyReport = { sent: 0, failed: 0, skipped: 0 };
  const notify = deps.notify;
  if (!notify) return report;
  const log = deps.log ?? (() => {});
  let rows: RenderRow[];
  try {
    rows = await deps.renders.listUnnotified(new Date(deps.now().getTime() - NOTIFY_WINDOW_MINUTES * 60_000).toISOString(), NOTIFY_BATCH);
  } catch {
    log('video_email_list_failed', { code: 'store_failed' });
    return report;
  }

  for (const row of rows) {
    if (row.state !== 'done' && row.state !== 'failed') continue;
    try {
      const pack = await deps.renders.getPack(row.packId);
      let decision = await decideVideoEmail(deps, row, pack);
      let to: string | null = null;
      if (decision.email && pack) {
        to = await notify.ownerEmail(pack.ownerId);
        // No address to write to: nothing to retry either.
        if (!to) decision = { outcome: 'skipped', email: false };
      }

      const atIso = deps.now().toISOString();
      const claimed = await deps.renders.claimNotify({ id: row.id, state: row.state, outcome: decision.outcome, atIso });
      if (!claimed) continue; // someone else has it, or the row was re-queued: not ours to send
      if (!decision.email || !to || decision.outcome === 'skipped') {
        report.skipped++;
        log('video_email_skipped', { packId: row.packId, code: decision.outcome });
        continue;
      }

      const outcome: VideoEmailOutcome = decision.outcome === 'ready' ? 'ready' : 'failed';
      let sent = false;
      try {
        sent = (await notify.send(to, { outcome, errorCode: outcome === 'failed' ? claimed.errorCode : null, idempotencyKey: videoEmailKey(claimed.id, outcome, claimed.finishedAt) })).sent === true;
      } catch {
        sent = false;
      }
      if (sent) {
        report.sent++;
        log('video_email_sent', { packId: row.packId, code: outcome });
      } else {
        report.failed++;
        log('video_email_failed', { packId: row.packId, code: 'send_failed' });
        // Give the claim back so the next tick tries again; a failure to do even that is only logged.
        try {
          await deps.renders.releaseNotify(row.id, atIso);
        } catch {
          log('video_email_release_failed', { packId: row.packId, code: 'store_failed' });
        }
      }
    } catch {
      // A store hiccup on this row: it stays unclaimed (or is released) and the next tick looks again.
      report.failed++;
      log('video_email_error', { packId: row.packId, code: 'store_failed' });
    }
  }
  return report;
}
