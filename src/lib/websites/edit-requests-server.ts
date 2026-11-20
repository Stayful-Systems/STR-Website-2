/**
 * Batch 36 (Phase 5): the change-request engine. Dependencies are injected
 * (the store, the bucket, the emails, the activity log), so it is tested
 * without a database; edit-requests-store.ts is the real wiring. Not
 * server-only for the same reason (golive-server.ts, purchase-server.ts).
 *
 * Who can do what:
 *   operator   createRequest, listOwn, getOwn: every one takes the account
 *              owner's id from the signed-in session (websiteActor), never from
 *              a form, and reads or writes only that owner's rows. There is no
 *              operator path that changes a request after it is sent.
 *   admin      adminList, adminSetStatus, adminScreenshotUrl, openCounts
 *              (Phase 8's console calls these behind requireAdmin()).
 *
 * Emails: a new request goes to every admin address (key website-request:<id>:
 * <address>); done or declined goes to the operator ONCE (closed_emailed_at is
 * claimed first, key website-request-closed:<id>). Both are direct replies, so
 * they sit outside the daily cap, as the feedback emails do.
 *
 * A screenshot is optional. A missing bucket, a wrong type or a big file never
 * stops the text from being sent: the request goes, the screenshot is refused
 * with a plain message.
 *
 * Logs carry ids and codes only: never the request text, a note or an address.
 */
import { sniffImage } from '../funnels/image.ts';
import {
  REQUEST_SIGNED_URL_SECONDS,
  SCREENSHOT_BUCKET_MISSING,
  canTransition,
  isClosedStatus,
  isOurScreenshotPath,
  screenshotPath,
  screenshotRefusal,
  validateAdminNotes,
  validateRequestBody,
  type RequestStatus,
} from './edit-requests.ts';

export interface RequestRow {
  id: string;
  websiteId: string;
  ownerId: string;
  body: string;
  screenshotPath: string | null;
  status: RequestStatus;
  adminNotes: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  closedEmailedAt: string | null;
}

export interface RequestStore {
  insert(row: { id: string; websiteId: string; ownerId: string; body: string }): Promise<RequestRow | null>;
  setScreenshot(id: string, path: string): Promise<boolean>;
  /** Only this owner's rows, newest first. */
  listForOwner(ownerId: string): Promise<RequestRow[]>;
  /** Every owner's rows, newest first (admin). `openOnly`: new and in progress. */
  list(opts: { openOnly: boolean }): Promise<RequestRow[]>;
  get(id: string): Promise<RequestRow | null>;
  /** Move a request, only while it is still in `from`. Null when it moved first. `adminNotes: undefined` keeps the notes. */
  move(id: string, from: RequestStatus, patch: { status: RequestStatus; adminNotes?: string | null; closedAt: string | null }): Promise<RequestRow | null>;
  /** Change only the notes. */
  setNotes(id: string, notes: string | null): Promise<RequestRow | null>;
  /** Claim the one closed email: true for exactly one caller, only on a done or declined request. */
  claimClosedEmail(id: string): Promise<boolean>;
  releaseClosedEmail(id: string): Promise<void>;
  /** website_id and status of every open request, for the console's counts. */
  openRows(): Promise<{ websiteId: string; status: RequestStatus }[]>;
}

export type UploadOutcome = 'ok' | 'bucket_missing' | 'failed';

export interface EmailOutcome {
  sent: boolean;
  reason?: string;
}

export interface RequestsDeps {
  store: RequestStore;
  uploadScreenshot(path: string, bytes: Uint8Array, mime: 'image/png' | 'image/jpeg'): Promise<UploadOutcome>;
  signScreenshot(path: string, seconds: number): Promise<string | null>;
  /** The operator's company name (a setting, never request text), for the admin email. */
  companyName(websiteId: string): Promise<string | null>;
  ownerEmail(ownerId: string): Promise<string | null>;
  adminAddresses(): string[];
  sendAdmin(to: string, requestId: string, data: { company: string | null; body: string; hasScreenshot: boolean }): Promise<EmailOutcome>;
  sendClosed(to: string | null, requestId: string, data: { status: 'done' | 'declined'; body: string; adminNote: string | null }): Promise<EmailOutcome>;
  /** Record-only activity (website_change_requested). Never throws into the request. */
  recordRequested(ownerId: string, requestId: string): void | Promise<void>;
  newId(): string;
  now(): Date;
  /** One line: ids and codes only. */
  log(line: string): void;
}

// ── The operator's side ──

export type CreateResult =
  | { ok: true; id: string; screenshot: 'none' | 'saved' | 'refused'; screenshotMessage?: string }
  | { ok: false; error: string };

export interface RequestsEngine {
  createRequest(input: { ownerId: string; websiteId: string; body: unknown; screenshot?: Uint8Array | null }): Promise<CreateResult>;
  listOwn(ownerId: string): Promise<RequestRow[]>;
  getOwn(ownerId: string, id: string): Promise<RequestRow | null>;
  adminList(opts?: { openOnly?: boolean }): Promise<RequestRow[]>;
  adminSetStatus(input: { id: string; status: RequestStatus; notes?: unknown }): Promise<SetStatusResult>;
  adminScreenshotUrl(id: string): Promise<string | null>;
  /** Per website: requests that are new, and requests still open (new + in progress). */
  openCounts(): Promise<Map<string, { new: number; open: number }>>;
}

export type SetStatusResult =
  | { ok: true; request: RequestRow; email: 'sent' | 'already' | 'failed' | 'none' }
  | { ok: false; reason: 'not_found' | 'bad_transition' | 'bad_notes' | 'changed'; message: string };

export function createRequestsEngine(deps: RequestsDeps): RequestsEngine {
  const { store } = deps;

  async function notifyAdmins(row: RequestRow, hasScreenshot: boolean): Promise<void> {
    let company: string | null = null;
    try {
      company = await deps.companyName(row.websiteId);
    } catch {
      company = null;
    }
    for (const to of deps.adminAddresses()) {
      try {
        const r = await deps.sendAdmin(to, row.id, { company, body: row.body, hasScreenshot });
        if (!r.sent && r.reason !== 'already_sent') deps.log(`website_request_admin_email id=${row.id} not_sent=${r.reason ?? 'unknown'}`);
      } catch {
        deps.log(`website_request_admin_email id=${row.id} error`);
      }
    }
  }

  async function sendClosedOnce(row: RequestRow): Promise<'sent' | 'already' | 'failed' | 'none'> {
    if (!isClosedStatus(row.status)) return 'none';
    // Claimed first: two admins pressing Done together, or a retry, send one email.
    if (!(await store.claimClosedEmail(row.id))) return 'already';
    let outcome: EmailOutcome = { sent: false, reason: 'error' };
    try {
      outcome = await deps.sendClosed(await deps.ownerEmail(row.ownerId), row.id, { status: row.status, body: row.body, adminNote: row.adminNotes });
    } catch {
      outcome = { sent: false, reason: 'error' };
    }
    if (outcome.sent) return 'sent';
    // Not sent (no address, email off, an error): give the claim back so saving the request again retries it.
    await store.releaseClosedEmail(row.id).catch(() => undefined);
    deps.log(`website_request_closed_email id=${row.id} not_sent=${outcome.reason ?? 'unknown'}`);
    return 'failed';
  }

  return {
    async createRequest({ ownerId, websiteId, body, screenshot }) {
      const checked = validateRequestBody(body);
      if (!checked.ok) return { ok: false, error: checked.error };

      const id = deps.newId();
      const row = await store.insert({ id, websiteId, ownerId, body: checked.value });
      if (!row) {
        deps.log(`website_request_insert_failed owner=${ownerId}`);
        return { ok: false, error: 'We could not send your request just now. Please try again.' };
      }

      try {
        await deps.recordRequested(ownerId, id);
      } catch {
        // A missed log line is not a reason to lose a request.
      }

      // The screenshot never stops the text: it is stored, or refused with a reason.
      let shot: 'none' | 'saved' | 'refused' = 'none';
      let message: string | undefined;
      if (screenshot && screenshot.length > 0) {
        const refusal = screenshotRefusal(screenshot);
        const mime = sniffImage(screenshot);
        const path = mime ? screenshotPath(ownerId, id, mime) : null;
        if (refusal || !mime || !path) {
          shot = 'refused';
          message = refusal ?? 'We could not use that screenshot.';
        } else {
          const up = await deps.uploadScreenshot(path, screenshot, mime);
          if (up === 'ok' && (await store.setScreenshot(id, path))) {
            shot = 'saved';
          } else {
            shot = 'refused';
            message = up === 'bucket_missing' ? SCREENSHOT_BUCKET_MISSING : 'We could not store that screenshot just now, so your request was sent without it.';
            deps.log(`website_request_screenshot id=${id} code=${up === 'ok' ? 'not_saved' : up}`);
          }
        }
      }

      await notifyAdmins(row, shot === 'saved');
      return { ok: true, id, screenshot: shot, ...(message ? { screenshotMessage: message } : {}) };
    },

    listOwn: (ownerId) => store.listForOwner(ownerId),

    async getOwn(ownerId, id) {
      const row = await store.get(id);
      // Another owner's request reads as not found, never as forbidden.
      return row && row.ownerId === ownerId ? row : null;
    },

    adminList: (opts) => store.list({ openOnly: opts?.openOnly === true }),

    async adminSetStatus({ id, status, notes }) {
      const hasNotes = notes !== undefined;
      const n = hasNotes ? validateAdminNotes(notes) : null;
      if (n && !n.ok) return { ok: false, reason: 'bad_notes', message: n.error };
      const noteValue = n && n.ok ? n.value : undefined;

      const row = await store.get(id);
      if (!row) return { ok: false, reason: 'not_found', message: 'That request is not there any more.' };

      // The same status: only the note changes, and a closed request whose email never went gets it now.
      if (status === row.status) {
        const saved = hasNotes ? await store.setNotes(id, noteValue ?? null) : row;
        if (!saved) return { ok: false, reason: 'not_found', message: 'That request is not there any more.' };
        const email = !isClosedStatus(saved.status) ? 'none' : saved.closedEmailedAt === null ? await sendClosedOnce(saved) : 'already';
        return { ok: true, request: saved, email };
      }

      if (!canTransition(row.status, status)) return { ok: false, reason: 'bad_transition', message: 'A request can only move forward: new, in progress, then done or not going ahead.' };

      const moved = await store.move(id, row.status, {
        status,
        ...(hasNotes ? { adminNotes: noteValue ?? null } : {}),
        closedAt: isClosedStatus(status) ? deps.now().toISOString() : null,
      });
      if (!moved) return { ok: false, reason: 'changed', message: 'Someone else changed that request first. Reload to see it.' };
      return { ok: true, request: moved, email: await sendClosedOnce(moved) };
    },

    async adminScreenshotUrl(id) {
      const row = await store.get(id);
      if (!row || !isOurScreenshotPath(row.screenshotPath)) return null;
      try {
        return await deps.signScreenshot(row.screenshotPath, REQUEST_SIGNED_URL_SECONDS);
      } catch {
        return null;
      }
    },

    async openCounts() {
      const out = new Map<string, { new: number; open: number }>();
      for (const r of await store.openRows()) {
        const c = out.get(r.websiteId) ?? { new: 0, open: 0 };
        c.open += 1;
        if (r.status === 'new') c.new += 1;
        out.set(r.websiteId, c);
      }
      return out;
    },
  };
}
