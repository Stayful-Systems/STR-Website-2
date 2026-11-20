import 'server-only';

/**
 * Live wiring for the no-spend reminder cron (idle-reminders-run.ts, Batch
 * 34b Phase 12): the admin client, the settings, the cap (notify/sends.ts),
 * the emails (email/credit-idle.ts) and the activity log. Service role only.
 * Logs carry a short user id, the stage and an outcome, never an email.
 */
import { createAdminClient } from '../supabase/admin';
import { abandonSend, claimSlot, finishSend, markSending, releaseClaim, slotsInUse } from '../notify/sends';
import { notificationState, type NotificationRow } from '../notifications/registry';
import { creditIdleFinalWarningEmail, creditIdleReminderEmail } from '../email/credit-idle';
import { recordActivity } from '../activity/log';
import { getBalance, idlePlanReport } from './ledger';
import { idleStages, type IdleNoticeRow } from './rollover';
import type { IdleRemindersDeps, IdleReminderMember, IdleReminderSettings } from './idle-reminders-run';

const ID_CHUNK = 150;
const SETTING_KEYS = ['plan_credit_idle_months', 'plan_credit_final_notice_days', 'plan_credit_idle_reminder_months'];

/** A billing_settings number, as credit_setting_num reads it: missing or unreadable means the default; at least 1, whole. */
function settingNum(raw: unknown, fallback: number): number {
  const n = Number(typeof raw === 'string' ? raw.trim() : raw);
  return Math.max(1, Math.round(raw == null || raw === '' || !Number.isFinite(n) ? fallback : n));
}

/** The reminder settings from billing_settings (the SQL defaults when a row is missing: 12 months, 30 days). */
export async function readIdleReminderSettings(admin: ReturnType<typeof createAdminClient>): Promise<IdleReminderSettings> {
  const { data, error } = await admin.from('billing_settings').select('key, value').in('key', SETTING_KEYS);
  if (error) throw new Error(error.message);
  const kv = new Map(((data ?? []) as { key: string; value: unknown }[]).map((r) => [r.key, r.value]));
  const idleMonths = settingNum(kv.get('plan_credit_idle_months'), 12);
  return {
    idleMonths,
    finalNoticeDays: settingNum(kv.get('plan_credit_final_notice_days'), 30),
    stages: idleStages(kv.get('plan_credit_idle_reminder_months'), idleMonths),
  };
}

export function liveIdleRemindersDeps(): IdleRemindersDeps {
  const admin = createAdminClient();
  return {
    settings: () => readIdleReminderSettings(admin),
    candidates: (now, minMonths) => idlePlanReport(now, minMonths),

    notices: async (userIds) => {
      const out = new Map<string, Array<IdleNoticeRow & { idleSince: string }>>();
      for (let i = 0; i < userIds.length; i += ID_CHUNK) {
        const { data, error } = await admin.from('credit_idle_notices').select('user_id, idle_since, stage, status').in('user_id', userIds.slice(i, i + ID_CHUNK));
        if (error) throw new Error(error.message);
        for (const r of (data ?? []) as { user_id: string; idle_since: string; stage: number; status: 'sent' | 'skipped' }[]) {
          out.set(r.user_id, [...(out.get(r.user_id) ?? []), { idleSince: r.idle_since, stage: Number(r.stage), status: r.status }]);
        }
      }
      return out;
    },

    members: async (userIds) => {
      const out = new Map<string, IdleReminderMember>();
      for (let i = 0; i < userIds.length; i += ID_CHUNK) {
        const { data, error } = await admin.from('profiles').select('id, email, alert_credit').in('id', userIds.slice(i, i + ID_CHUNK));
        if (error) throw new Error(error.message);
        for (const r of (data ?? []) as Array<{ id: string; email: string | null } & NotificationRow>) {
          out.set(r.id, { alertsOn: notificationState(r).credit_alerts, email: r.email ?? null });
        }
      }
      return out;
    },

    slotsUsedToday: async (userIds, now) => {
      const used = await slotsInUse(admin, userIds, 'daily', now);
      return used ? new Set(used.keys()) : null;
    },
    balancePence: async (userId) => (await getBalance(userId)).totalPence,

    claimSlot: async (userId, kind, now) => {
      const c = await claimSlot(admin, userId, kind, now);
      return c.ok ? { ok: true, id: c.id } : { ok: false, reason: c.reason };
    },
    releaseClaim: (id) => releaseClaim(admin, id),
    markSending: (id, summary) => markSending(admin, id, summary, null),
    abandonSend: (id) => abandonSend(admin, id),
    finishSend: async (id, summary) => {
      await finishSend(admin, id, true, summary, []);
    },

    sendReminder: (to, data, idempotencyKey) => creditIdleReminderEmail(to, data, { idempotencyKey }),
    sendFinalWarning: (to, data, idempotencyKey) => creditIdleFinalWarningEmail(to, data, { idempotencyKey }),

    recordSkipped: async (userId, idleSince, stage) => {
      const { error } = await admin
        .from('credit_idle_notices')
        .upsert({ user_id: userId, idle_since: idleSince, stage, status: 'skipped', sent_at: null }, { onConflict: 'user_id,idle_since,stage', ignoreDuplicates: true });
      if (error) throw new Error(`credit_idle_notices write failed: ${error.message}`);
    },
    stampSent: async (userId, idleSince, stage, sentAt) => {
      const { error } = await admin
        .from('credit_idle_notices')
        .upsert({ user_id: userId, idle_since: idleSince, stage, status: 'sent', sent_at: sentAt.toISOString() }, { onConflict: 'user_id,idle_since,stage' });
      if (error) throw new Error(`credit_idle_notices write failed: ${error.message}`);
    },
    recordActivity: (userId, { dedupeKey, stage, kind }) => recordActivity(userId, 'credit_idle_reminder', { dedupeKey, extras: { stage, kind } }),
    log: (line) => console.log(line),
  };
}
