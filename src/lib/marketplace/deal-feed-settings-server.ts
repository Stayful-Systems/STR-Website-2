import 'server-only';

/**
 * Reads the deal feed's billing_settings rows. Any failure reads as the
 * defaults, which are both switches OFF, so a database that has not had the
 * "Deal feed" block run behaves exactly as before.
 */
import { createAdminClient } from '../supabase/admin';
import { hasServiceRole } from '../credit/db';
import { DEAL_FEED_SETTING_KEYS, DEFAULT_DEAL_FEED_SETTINGS, parseDealFeedSettings, type DealFeedSettings } from './deal-feed-settings';

export async function readDealFeedSettings(): Promise<DealFeedSettings> {
  if (!hasServiceRole()) return DEFAULT_DEAL_FEED_SETTINGS;
  try {
    const { data, error } = await createAdminClient().from('billing_settings').select('key, value').in('key', Object.values(DEAL_FEED_SETTING_KEYS));
    if (error) {
      console.warn('[deal-feed] settings unreadable, using the defaults:', error.code ?? 'error');
      return DEFAULT_DEAL_FEED_SETTINGS;
    }
    return parseDealFeedSettings((data ?? []) as { key: string; value: unknown }[]);
  } catch (err) {
    console.warn('[deal-feed] settings unreadable, using the defaults:', (err as Error)?.message ?? err);
    return DEFAULT_DEAL_FEED_SETTINGS;
  }
}
