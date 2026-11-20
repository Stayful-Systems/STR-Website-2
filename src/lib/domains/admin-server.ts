import 'server-only';

import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { parseSiteSettings } from '../websites/store-server';
import { buildRow, type DomainListRow } from './admin-view';
import { registrarConfigured } from './registrar';
import { readDomainSettings, listDomainRows } from './store-server';
import { ukDay } from './cron-run';
import { vercelConfigured } from './vercel';
import type { DomainSettings } from './settings';

/**
 * Batch 33: what /admin/management's Domains panel shows. Reads only (service
 * role): every domain with its site, its member's email, what it cost, when it
 * renews, its status and the last error (a code), with the reason it is where
 * it is (admin-view.ts). No registrar reference and no response body is read
 * into the panel.
 */

export interface DomainsAdminData {
  available: boolean;
  readError: string | null;
  settings: DomainSettings;
  rows: DomainListRow[];
  /** Pence claimed or bought today (UK day) against the daily cap. */
  usedTodayPence: number;
  registrarOn: boolean;
  vercelOn: boolean;
}

export async function loadDomainsAdmin(): Promise<DomainsAdminData> {
  const settings = await readDomainSettings();
  const base: DomainsAdminData = { available: hasServiceRole(), readError: null, settings, rows: [], usedTodayPence: 0, registrarOn: registrarConfigured(), vercelOn: vercelConfigured() };
  if (!base.available) return base;

  const admin = createAdminClient();
  const domains = await listDomainRows();
  const siteIds = [...new Set(domains.map((d) => d.websiteId))];
  const ownerIds = [...new Set(domains.map((d) => d.ownerId))];
  const [sites, members, spend] = await Promise.all([
    siteIds.length ? admin.from('websites').select('id, slug, settings').in('id', siteIds) : Promise.resolve({ data: [], error: null }),
    ownerIds.length ? admin.from('profiles').select('id, email').in('id', ownerIds) : Promise.resolve({ data: [], error: null }),
    admin.from('website_domain_spend').select('pence, status').eq('uk_day', ukDay(new Date())).in('status', ['claimed', 'bought']),
  ]);
  base.readError = sites.error?.message ?? members.error?.message ?? spend.error?.message ?? null;
  const siteBy = new Map((sites.data ?? []).map((s) => [String((s as { id: unknown }).id), { slug: String((s as { slug: unknown }).slug), company: parseSiteSettings((s as { settings: unknown }).settings).companyName }]));
  const emailBy = new Map((members.data ?? []).map((m) => [String((m as { id: unknown }).id), ((m as { email?: string | null }).email ?? null) as string | null]));
  base.usedTodayPence = ((spend.data ?? []) as Array<{ pence: number }>).reduce((n, r) => n + (typeof r.pence === 'number' ? r.pence : 0), 0);
  const ctx = { autoBuy: settings.autoBuy, capPence: settings.dailySpendCapPence, usedTodayPence: base.usedTodayPence };
  base.rows = domains.map((d) => buildRow(d, siteBy.get(d.websiteId) ?? null, emailBy.get(d.ownerId) ?? null, ctx));
  return base;
}
