import 'server-only';

import { readAdAccount } from '../leaddb/ad-account-server';
import { calculatorServes, isCalculatorMode } from './calculator';
import type { WebsiteRow } from './store-server';

/**
 * Batch 55 (Part A), phase A6: the stop rule at the public API.
 *
 * True when `site` is a calculator site whose owner's lead database ad route is
 * stopped (calculatorServes: no account, no state yet, lapsed, cancelled, a
 * cancel date that has arrived, or no card; a PAUSED account still serves).
 * A site that is not in calculator mode is never stopped here and the ad
 * account is not even read. Fails closed: an account that cannot be read is
 * "no account", which is stopped.
 *
 * Used ONLY by the three public requests that start something new: the step-1
 * lead route, the report-request route and address-autocomplete. The report
 * run itself (report-server.ts and the held-report cron) never calls this: a
 * report that is already running must finish, and it works from the report row.
 */
export async function calculatorStopped(site: Pick<WebsiteRow, 'mode' | 'userId'>): Promise<boolean> {
  if (!isCalculatorMode(site.mode)) return false;
  const account = await readAdAccount(site.userId);
  return !calculatorServes(site, account, new Date());
}
