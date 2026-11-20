import 'server-only';

import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { DEFAULT_TOPUP_THRESHOLD_PENCE } from './topup-floor';
import { getBalance, type Balance } from './ledger';
import { getBillingSettings } from './unit-costs';
import { getPlan } from './plans';
import { lowBalanceState, type BalanceState, type SpendRates } from './pricing';
import { isEnforcing } from './http';
import { accountStatus, type AccessProfile } from '../access';
import { isPackAccount } from '../lifecycle/settings';
import { planCycleView, type RolloverGrantRow } from './rollover';

/**
 * Everything the app chrome needs to know about a member's credit in one
 * object: buckets, the current cycle's allowance and how much of it is used
 * (drives the 80% banner), whether they are out, and top-up affordances.
 */
export interface CreditSummary {
  buckets: Balance['buckets'];
  totalPence: number;
  spendableBasePence: number;
  reservedBasePence: number;
  rates: SpendRates;
  cycle: { planCode: string | null; planName: string | null; allowancePence: number; usedPence: number; endsAt: string | null } | null;
  state: BalanceState;
  lowBalance: boolean;
  outOfCredit: boolean;
  enforcing: boolean;
  hasSavedCard: boolean;
  autoTopup: { amountPence: number | null; thresholdPence: number };
  topupPresetsPence: number[];
  welcomeWithheldReason: string | null;
  /** One day of daily deals in base pence (billing_settings.todays_5_daily_pence), for the Usage chip. */
  dailyDealsPence: number;
  /**
   * Batch 34: plan credit left from earlier cycles (grants older than the
   * newest renewal grant; rollover.ts). Part of buckets.planPence, not of
   * cycle.allowancePence. 0 with no plan.
   */
  rolledOverPence: number;
  /**
   * Batch 20: no live, trialling, past-due or paused plan (free, or lapsed):
   * low means £5 of credit or less (billing_settings.low_credit_pence), and
   * the choice offered is Starter or a £10 top-up.
   */
  noPlan: boolean;
}

/** Every welcome-kind grant this account has had, in pence. 0 when it cannot be read: the setting then stands. */
async function welcomeGrantedPence(userId: string): Promise<number> {
  if (!hasServiceRole()) return 0;
  const { data, error } = await createAdminClient().from('credit_grants').select('amount_pence').eq('user_id', userId).eq('kind', 'welcome');
  if (error) {
    console.warn('[credit] welcome grants read failed:', error.message);
    return 0;
  }
  return ((data ?? []) as { amount_pence: unknown }[]).reduce((n, r) => n + (Number(r.amount_pence) || 0), 0);
}

/**
 * Batch 34: every plan grant this account has had (rollover.ts reads this
 * cycle's, the banked credit and when the next credit arrives from them).
 * Null when it cannot be read (e.g. before schema.sql adds plan_cycle): the
 * plan's monthly credit then stands in for the allowance.
 *
 * This cycle's grants, not `billing_plans.monthly_credit_pence`, are the
 * allowance: plan credit changes at each member's NEXT renewal, so while a
 * change rolls out the plan row says one thing and the member's current grant
 * another.
 */
async function planGrantRows(userId: string): Promise<RolloverGrantRow[] | null> {
  if (!hasServiceRole()) return null;
  const { data, error } = await createAdminClient()
    .from('credit_grants')
    .select('amount_pence, remaining_pence, created_at, plan_cycle, source_ref, expires_at')
    .eq('user_id', userId)
    .eq('kind', 'plan');
  if (error) {
    console.warn('[credit] plan grants read failed:', error.message);
    return null;
  }
  return (data ?? []) as unknown as RolloverGrantRow[];
}

export async function getCreditSummary(userId: string): Promise<CreditSummary> {
  // Annual subscribers are credited month by month; make sure this month's slot exists.
  try {
    const { ensureAnnualMonthlyGrant } = await import('../stripe/grants');
    await ensureAnnualMonthlyGrant(userId);
  } catch {
    /* never block the summary */
  }
  const [balance, settings] = await Promise.all([getBalance(userId), getBillingSettings()]);
  type BillingProfile = AccessProfile & {
    plan_code: string | null;
    current_period_end: string | null;
    stripe_default_payment_method_id: string | null;
    auto_topup_amount_pence: number | null;
    auto_topup_threshold_pence: number | null;
    welcome_withheld_reason: string | null;
    created_at: string | null;
  };
  let profile: BillingProfile | null = null;
  if (hasServiceRole()) {
    const { data } = await createAdminClient()
      .from('profiles')
      .select('plan_code, current_period_end, stripe_default_payment_method_id, auto_topup_amount_pence, auto_topup_threshold_pence, welcome_withheld_reason, created_at, plan, plan_source, reports_run, stripe_subscription_id, stripe_subscription_status, subscription_paused_from, subscription_paused_until, subscription_cancel_at')
      .eq('id', userId)
      .maybeSingle();
    profile = (data as unknown as BillingProfile | null) ?? null;
  }
  // Batch 20: with no plan (free or lapsed) the £5 rule decides "low".
  const status = profile ? accountStatus(profile) : null;
  const noPlan = status === 'free' || status === 'lapsed';
  const plan = await getPlan(profile?.plan_code);

  let cycle: CreditSummary['cycle'] = null;
  let rolledOver = 0;
  if (plan) {
    // Batch 34: the allowance is this cycle's grants; banked plan credit shows
    // as rolledOverPence; endsAt is when the next plan credit arrives (about a
    // month away for an annual member, not the year end).
    const view = planCycleView(await planGrantRows(userId), {
      planMonthlyCreditPence: plan.monthlyCreditPence,
      currentPeriodEnd: profile?.current_period_end ?? null,
      fallbackEndsAt: balance.planExpiresAt ?? profile?.current_period_end ?? null,
    });
    const allowance = view.allowancePence;
    rolledOver = view.rolledOverPence;
    // Used = allowance − ALL plan credit, so "low" (used ≥ 80%) means plan credit below 20% of one month's.
    cycle = { planCode: plan.code, planName: plan.name, allowancePence: allowance, usedPence: Math.max(0, allowance - balance.buckets.planPence), endsAt: view.endsAt };
  } else {
    // Welcome credit is the welcome grant plus any first-week checklist
    // rewards (src/lib/today/checklist.ts), which are welcome-kind so they
    // spend at face value. Measured against what was actually granted, so the
    // rewards cannot make "used" read low; never below the setting, so an
    // account whose welcome was withheld reads exactly as it always has.
    // Batch 20: an account from the starter pack's cutover never had the welcome
    // credit, so it is measured only against what it was given (the pack's bonus).
    const floor = isPackAccount(profile?.created_at ?? null, settings.lifecycle) ? 0 : settings.welcomeGrantPence;
    const welcome = Math.max(floor, await welcomeGrantedPence(userId));
    cycle = welcome > 0 ? { planCode: null, planName: null, allowancePence: welcome, usedPence: Math.max(0, welcome - balance.buckets.welcomePence), endsAt: null } : null;
  }

  const state = lowBalanceState({
    cycleAllowancePence: cycle?.allowancePence ?? 0,
    cycleUsedPence: cycle?.usedPence ?? 0,
    spendableBasePence: balance.spendableBasePence,
    ratio: settings.lowBalanceRatio,
    balancePence: balance.totalPence,
    lowCreditPence: noPlan ? settings.lifecycle.lowCreditPence : null,
  });
  return {
    buckets: balance.buckets,
    totalPence: balance.totalPence,
    spendableBasePence: balance.spendableBasePence,
    reservedBasePence: balance.reservedBasePence,
    rates: balance.rates,
    cycle,
    state,
    lowBalance: state === 'low',
    outOfCredit: state === 'out',
    enforcing: isEnforcing(),
    hasSavedCard: Boolean(profile?.stripe_default_payment_method_id),
    autoTopup: { amountPence: profile?.auto_topup_amount_pence ?? null, thresholdPence: profile?.auto_topup_threshold_pence ?? DEFAULT_TOPUP_THRESHOLD_PENCE },
    topupPresetsPence: settings.topupPresetsPence,
    welcomeWithheldReason: profile?.welcome_withheld_reason ?? null,
    dailyDealsPence: settings.dealPricing.todays5DailyPence,
    rolledOverPence: rolledOver,
    noPlan,
  };
}
