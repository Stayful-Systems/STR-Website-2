/**
 * Batch 35 (Phase 6): the quiet-sheet email. Pure rules over an injected store
 * and sender, so they are tested without a database (quiet.test.ts);
 * quiet-server.ts is the real store.
 *
 * An ACTIVE link whose newest row (last_row_at, else activated_at) is
 * `ad_sheet_quiet_days` old or more, and which has not been emailed since its
 * last row (quiet_email_sent_at null), gets ONE email through the daily cap
 * (SendKind 'ad_sheet_quiet'). The stamp is written only after a send. A taken
 * slot (or an unreadable cap record) writes nothing, so the next daily run
 * tries again. A new row clears the stamp (import-server.ts saveLink), so the
 * email can go once more after another quiet period. Links that are waiting for
 * a test row, in error or disconnected never get it.
 *
 * The copy tells the operator what to check and types no figure but the days
 * from settings. Nothing here logs a lead: log lines carry a link id and a code.
 */
import type { WebsiteGraceCopy } from '../email/website-grace.ts';

export const DEFAULT_QUIET_DAYS = 7;
const DAY_MS = 86_400_000;

export interface QuietLink {
  id: string;
  ownerId: string;
  state: string;
  lastRowAt: string | null;
  activatedAt: string | null;
  quietEmailSentAt: string | null;
}

export type SendOutcome = { sent: boolean; reason?: string };
export type CapClaim = { ok: true; id: string } | { ok: false; reason: string };

export interface QuietStore {
  /** ad_sheet_quiet_days, already parsed (the default when missing or unreadable). */
  quietDays(): Promise<number>;
  /** Links in state active. The rules below re-check state and the stamp. */
  activeLinks(): Promise<QuietLink[]>;
  ownerEmail(ownerId: string): Promise<string | null>;
  claimSlot(userId: string, kind: 'ad_sheet_quiet', now: Date): Promise<CapClaim>;
  releaseClaim(claimId: string): Promise<void>;
  /** About to send; false: the cap record could not be written, so do not send. */
  markSending(claimId: string, summary: Record<string, unknown>): Promise<boolean>;
  abandonSend(claimId: string): Promise<void>;
  finishSend(claimId: string, summary: Record<string, unknown>): Promise<void>;
  /** Stamp quiet_email_sent_at (only where it is still null). */
  stamp(linkId: string, atIso: string): Promise<void>;
  send(to: string, copy: WebsiteGraceCopy, idempotencyKey: string): Promise<SendOutcome>;
  log(line: string): void;
}

export interface QuietEntry {
  linkId: string;
  /** 'sent' | 'due' (dry) | 'waiting' (cap) | 'no_recipient' | 'failed' | 'error' */
  code: string;
  reason?: string;
}

export interface QuietResult {
  ok: boolean;
  dry: boolean;
  checked: number;
  due: number;
  sent: number;
  waiting: number;
  failed: number;
  entries: QuietEntry[];
}

/** The newest sign of life: the last row, else the day the link went active. */
export function quietSince(l: Pick<QuietLink, 'lastRowAt' | 'activatedAt'>): string | null {
  return l.lastRowAt ?? l.activatedAt ?? null;
}

/** Whether the email is due for this link now. Pure. */
export function isQuietDue(l: QuietLink, days: number, now: Date): boolean {
  if (l.state !== 'active' || l.quietEmailSentAt !== null) return false;
  const since = quietSince(l);
  if (!since) return false;
  const t = new Date(since).getTime();
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t >= days * DAY_MS;
}

/** The email's copy. `days` is the setting's value; nothing else is typed. */
export function quietCopy(days: number): WebsiteGraceCopy {
  const n = `${days} ${days === 1 ? 'day' : 'days'}`;
  return {
    subject: `No Facebook leads through your form for ${n}`,
    title: `No Facebook leads for ${n}`,
    lines: [
      `No Facebook leads have arrived through your lead form for ${n}.`,
      'It may simply be a quiet spell. If you expected leads, please check three things:',
      '1. Your ads are running in your Meta account, and each one points at your instant lead form.',
      '2. Your lead form is still linked to your Google Sheet in Meta.',
      '3. The sheet is still shared with the Stayful email address shown on your Ads page.',
      'We will not send this again until a new lead has arrived and another quiet spell has passed.',
    ],
    cta: { label: 'Open my ads page', path: '/leads/ads' },
  };
}

/** Resend's key for one quiet spell: stable across retries, new once a row has moved the date on. */
export function quietKey(linkId: string, since: string): string {
  return `ad-sheet-quiet:${linkId}:${since}`;
}

const msg = (err: unknown): string => (err as Error)?.message ?? String(err);

/** One email through the daily cap: waits (writes nothing) when the slot is not free. */
async function sendThroughCap(
  store: QuietStore,
  a: { userId: string; now: Date; summary: Record<string, unknown>; send: () => Promise<SendOutcome> },
): Promise<{ status: 'sent' } | { status: 'waiting'; reason: string } | { status: 'failed'; reason: string }> {
  const claim = await store.claimSlot(a.userId, 'ad_sheet_quiet', a.now);
  if (!claim.ok) return { status: 'waiting', reason: claim.reason === 'slot_used' ? 'cap_used' : claim.reason };
  if (!(await store.markSending(claim.id, a.summary))) {
    await store.releaseClaim(claim.id);
    return { status: 'waiting', reason: 'cap_record_unavailable' };
  }
  let res: SendOutcome;
  try {
    res = await a.send();
  } catch (err) {
    res = { sent: false, reason: msg(err) };
  }
  if (!res.sent) {
    await store.abandonSend(claim.id);
    return { status: 'failed', reason: res.reason ?? 'send_failed' };
  }
  await store.finishSend(claim.id, a.summary);
  return { status: 'sent' };
}

/**
 * The check. `dry` lists what is due and sends, claims and stamps nothing.
 * Never throws: a failure for one link is a code on its entry.
 */
export async function runQuietCheck(store: QuietStore, opts: { dry?: boolean; now?: Date } = {}): Promise<QuietResult> {
  const dry = opts.dry === true;
  const now = opts.now ?? new Date();
  const out: QuietResult = { ok: true, dry, checked: 0, due: 0, sent: 0, waiting: 0, failed: 0, entries: [] };

  let days: number;
  let links: QuietLink[];
  try {
    days = await store.quietDays();
    links = await store.activeLinks();
  } catch (err) {
    store.log(`[ad-sheets] quiet check could not load: ${msg(err)}`);
    return { ...out, ok: false };
  }
  out.checked = links.length;

  for (const l of links) {
    if (!isQuietDue(l, days, now)) continue;
    out.due += 1;
    if (dry) {
      out.entries.push({ linkId: l.id, code: 'due' });
      continue;
    }
    try {
      const to = await store.ownerEmail(l.ownerId);
      if (!to) {
        out.failed += 1;
        out.entries.push({ linkId: l.id, code: 'no_recipient' });
        continue;
      }
      const since = quietSince(l) as string;
      const r = await sendThroughCap(store, {
        userId: l.ownerId,
        now,
        summary: { kind: 'ad_sheet_quiet', link: l.id },
        send: () => store.send(to, quietCopy(days), quietKey(l.id, since)),
      });
      if (r.status === 'sent') {
        // The stamp only after a send. If it cannot be written the next run may send again (Resend's key holds for a day).
        await store.stamp(l.id, now.toISOString());
        out.sent += 1;
        out.entries.push({ linkId: l.id, code: 'sent' });
      } else if (r.status === 'waiting') {
        out.waiting += 1;
        out.entries.push({ linkId: l.id, code: 'waiting', reason: r.reason });
      } else {
        out.failed += 1;
        out.entries.push({ linkId: l.id, code: 'failed', reason: r.reason });
      }
    } catch (err) {
      store.log(`[ad-sheets] quiet check failed for link ${l.id}: ${msg(err)}`);
      out.failed += 1;
      out.entries.push({ linkId: l.id, code: 'error' });
    }
  }
  return out;
}
