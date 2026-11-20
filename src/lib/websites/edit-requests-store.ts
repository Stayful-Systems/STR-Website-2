import 'server-only';

import { randomUUID } from 'node:crypto';
import { adminEmails } from '../admin';
import { logActivity } from '../activity/log';
import { sendRequestAdminEmail, sendRequestClosedEmail } from '../email/website-edit';
import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { REQUEST_BUCKET, isRequestStatus } from './edit-requests';
import { createRequestsEngine, type RequestRow, type RequestStore, type RequestsDeps, type RequestsEngine } from './edit-requests-server';

/**
 * Batch 36 (Phase 5): website_change_requests over Supabase (service role
 * only), and the engine (edit-requests-server.ts) wired to the real bucket,
 * emails and activity log. The private bucket website-requests is made by hand
 * in Supabase like brand-assets: if it is missing, a request still sends and
 * the screenshot is refused with a plain message.
 *
 * Every read an operator makes is filtered by the owner's id here. Nothing
 * here logs a request, a note or an address: a failed call logs the table and
 * the database's error code.
 */

const COLUMNS = 'id, website_id, owner_id, body, screenshot_path, status, admin_notes, created_at, updated_at, closed_at, closed_emailed_at';

type Admin = ReturnType<typeof createAdminClient>;
const admin = (): Admin => createAdminClient();

export function toRequestRow(r: Record<string, unknown>): RequestRow {
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  return {
    id: String(r.id),
    websiteId: String(r.website_id),
    ownerId: String(r.owner_id),
    body: String(r.body ?? ''),
    screenshotPath: str(r.screenshot_path),
    status: isRequestStatus(r.status) ? r.status : 'new',
    adminNotes: str(r.admin_notes),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    closedAt: str(r.closed_at),
    closedEmailedAt: str(r.closed_emailed_at),
  };
}

function fail(what: string, error: { code?: string } | null): void {
  console.error(`[website-requests] ${what} failed${error?.code ? ` (${error.code})` : ''}`);
}

export function createLiveRequestStore(): RequestStore {
  const table = () => admin().from('website_change_requests');
  return {
    async insert(row) {
      const { data, error } = await table()
        .insert({ id: row.id, website_id: row.websiteId, owner_id: row.ownerId, body: row.body })
        .select(COLUMNS)
        .maybeSingle();
      if (error || !data) {
        fail('insert', error);
        return null;
      }
      return toRequestRow(data as Record<string, unknown>);
    },
    async setScreenshot(id, path) {
      const { error } = await table().update({ screenshot_path: path, updated_at: new Date().toISOString() }).eq('id', id);
      if (error) fail('screenshot path', error);
      return !error;
    },
    async listForOwner(ownerId) {
      const { data, error } = await table().select(COLUMNS).eq('owner_id', ownerId).order('created_at', { ascending: false });
      if (error) {
        fail('list own', error);
        return [];
      }
      return (data ?? []).map((r) => toRequestRow(r as Record<string, unknown>));
    },
    async list({ openOnly }) {
      let q = table().select(COLUMNS).order('created_at', { ascending: false }).limit(500);
      if (openOnly) q = q.in('status', ['new', 'in_progress']);
      const { data, error } = await q;
      if (error) {
        fail('list', error);
        return [];
      }
      return (data ?? []).map((r) => toRequestRow(r as Record<string, unknown>));
    },
    async get(id) {
      const { data, error } = await table().select(COLUMNS).eq('id', id).maybeSingle();
      if (error) fail('get', error);
      return data ? toRequestRow(data as Record<string, unknown>) : null;
    },
    async move(id, from, patch) {
      const set: Record<string, unknown> = { status: patch.status, closed_at: patch.closedAt, updated_at: new Date().toISOString() };
      if (patch.adminNotes !== undefined) set.admin_notes = patch.adminNotes;
      const { data, error } = await table().update(set).eq('id', id).eq('status', from).select(COLUMNS).maybeSingle();
      if (error) fail('move', error);
      return data ? toRequestRow(data as Record<string, unknown>) : null;
    },
    async setNotes(id, notes) {
      const { data, error } = await table().update({ admin_notes: notes, updated_at: new Date().toISOString() }).eq('id', id).select(COLUMNS).maybeSingle();
      if (error) fail('notes', error);
      return data ? toRequestRow(data as Record<string, unknown>) : null;
    },
    async claimClosedEmail(id) {
      const { data, error } = await table()
        .update({ closed_emailed_at: new Date().toISOString() })
        .eq('id', id)
        .is('closed_emailed_at', null)
        .in('status', ['done', 'declined'])
        .select('id');
      if (error) {
        fail('claim closed email', error);
        return false;
      }
      return (data?.length ?? 0) > 0;
    },
    async releaseClosedEmail(id) {
      const { error } = await table().update({ closed_emailed_at: null }).eq('id', id);
      if (error) fail('release closed email', error);
    },
    async openRows() {
      const { data, error } = await table().select('website_id, status').in('status', ['new', 'in_progress']);
      if (error) {
        fail('open rows', error);
        return [];
      }
      return (data ?? []).map((r) => ({ websiteId: String((r as { website_id: unknown }).website_id), status: isRequestStatus((r as { status: unknown }).status) ? ((r as { status: string }).status as RequestRow['status']) : 'new' }));
    },
  };
}

/** Supabase reports a missing bucket as text, not a code. */
const bucketMissing = (message: string): boolean => /bucket not found|does not exist/i.test(message);

export function liveRequestsDeps(): RequestsDeps {
  return {
    store: createLiveRequestStore(),
    async uploadScreenshot(path, bytes, mime) {
      if (!hasServiceRole()) return 'bucket_missing';
      try {
        const { error } = await admin().storage.from(REQUEST_BUCKET).upload(path, bytes, { contentType: mime, upsert: false });
        if (!error) return 'ok';
        return bucketMissing(error.message ?? '') ? 'bucket_missing' : 'failed';
      } catch {
        return 'failed';
      }
    },
    async signScreenshot(path, seconds) {
      const { data, error } = await admin().storage.from(REQUEST_BUCKET).createSignedUrl(path, seconds);
      if (error) fail('sign screenshot', null);
      return data?.signedUrl ?? null;
    },
    async companyName(websiteId) {
      const { data } = await admin().from('websites').select('settings').eq('id', websiteId).maybeSingle();
      const name = (data as { settings?: { companyName?: unknown } } | null)?.settings?.companyName;
      return typeof name === 'string' && name.trim() ? name.trim() : null;
    },
    async ownerEmail(ownerId) {
      const { data } = await admin().from('profiles').select('email').eq('id', ownerId).maybeSingle();
      const email = (data as { email?: unknown } | null)?.email;
      return typeof email === 'string' && email ? email : null;
    },
    adminAddresses: () => adminEmails(),
    sendAdmin: (to, requestId, data) => sendRequestAdminEmail(to, requestId, data),
    sendClosed: (to, requestId, data) => sendRequestClosedEmail(to, requestId, data),
    recordRequested(ownerId, requestId) {
      // Record only (weekly active is unchanged). Runs inside the action, after the response.
      logActivity(ownerId, 'website_change_requested', { dedupeKey: `website_change_request:${requestId}`, extras: { website: true } });
    },
    newId: () => randomUUID(),
    now: () => new Date(),
    log: (line) => console.warn(`[website-requests] ${line}`),
  };
}

/** The engine on the real store. Phase 8's console actions use this behind requireAdmin(). */
export function liveRequestsEngine(): RequestsEngine {
  return createRequestsEngine(liveRequestsDeps());
}
