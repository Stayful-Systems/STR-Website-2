/**
 * The words the usage chip, the low-credit banner and the Usage page use for
 * the balance (Batch 32a, Phase 4). Pure: the caller passes the money
 * formatter, so each surface keeps the one it already used.
 */

type Money = (pence: number) => string;

/** "£Y of your balance rolled over", or null when nothing has rolled over. */
export function rolledOverWords(rolledOverPence: number | undefined | null, fmt: Money): string | null {
  const y = Math.round(rolledOverPence ?? 0);
  return y > 0 ? `${fmt(y)} of your balance rolled over` : null;
}

/** "about X days of daily deals" (X = whole days), or null with no daily price. */
export function daysWords(days: number | null): string | null {
  return days !== null ? `about ${days} day${days === 1 ? "" : "s"} of daily deals` : null;
}

/**
 * The chip's tooltip: who the balance belongs to, the days of daily deals
 * and (when above zero) the rolled-over amount.
 */
export function chipTitle(opts: { teamName?: string | null; days: number | null; rolledOverPence?: number | null }, fmt: Money): string {
  const lead = opts.teamName ? `${opts.teamName}'s balance — the account owner tops it up` : "Your credit and where it goes";
  return [lead, daysWords(opts.days), rolledOverWords(opts.rolledOverPence, fmt)].filter(Boolean).join(" · ");
}

/** The chip's aria-label: the balance, the days, the rolled-over amount, then where it goes. */
export function chipAria(opts: { team: boolean; totalPence: number; days: number | null; rolledOverPence?: number | null }, fmt: Money): string {
  const parts = [`${opts.team ? "Team balance" : "Balance"} ${fmt(opts.totalPence)}`, daysWords(opts.days), rolledOverWords(opts.rolledOverPence, fmt)].filter(Boolean);
  return `${parts.join(", ")}. See usage.`;
}

/** The banner's low-balance text: the balance, not a percentage. */
export function lowBalanceText(totalPence: number, hasPlan: boolean, fmt: Money): string {
  return `Running low: ${fmt(totalPence)} of credit left${hasPlan ? "" : " · upgrade for monthly credit"}.`;
}

/**
 * The Usage page's plan line: "£X plan credit this month · £Y of your balance
 * rolled over". Either part is left out when it is zero; null when both are.
 */
export function planCreditLine(allowancePence: number, rolledOverPence: number | undefined | null, fmt: Money): string | null {
  const parts: string[] = [];
  if (allowancePence > 0) parts.push(`${fmt(allowancePence)} plan credit this month`);
  const rolled = rolledOverWords(rolledOverPence, fmt);
  if (rolled) parts.push(rolled);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The billing card's plan-credit line (Batch 32a, Phase 5): "£Y rolled over
 * from earlier months · next £X arrives {date}". Either part is left out when
 * it does not apply: Y is 0, or the plan is not renewing (cancelling, ended,
 * no date), so nothing is promised that will not arrive. Null when both are.
 */
export function rolledOverBillingLine(
  opts: { rolledOverPence: number | undefined | null; allowancePence: number; nextAt: string | null; renewing: boolean },
  fmt: Money,
  fmtDate: (iso: string) => string | null,
): string | null {
  const parts: string[] = [];
  const y = Math.round(opts.rolledOverPence ?? 0);
  if (y > 0) parts.push(`${fmt(y)} rolled over from earlier months`);
  const date = opts.renewing && opts.nextAt ? fmtDate(opts.nextAt) : null;
  if (date && opts.allowancePence > 0) parts.push(`next ${fmt(opts.allowancePence)} arrives ${date}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
