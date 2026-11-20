"use client";

import Link from "next/link";
import { formatGbp } from "@/lib/credit/client";
import { dailyDealsDaysLeft } from "@/lib/credit/deal-pricing";
import { chipAria, chipTitle, daysWords } from "@/lib/credit/balance-words";
import { useCreditOptional } from "./CreditProvider";

/**
 * The usage chip in the app nav (Batch 10), in the credit badge's place and
 * with its colours (amber when low, red when out). On a plan or pay as you
 * go alike: the balance and about how many days of daily deals it covers, and
 * (in the tooltip) how much of the balance rolled over from earlier months.
 * A team member sees the team's. It goes to the Usage page.
 */
export function UsageChip() {
  const ctx = useCreditOptional();
  const c = ctx?.credit;
  if (!c) return null;
  const tone = c.admin ? { bg: "rgba(255,255,255,0.12)", fg: "#fff" } : c.outOfCredit ? { bg: "#7f1d1d", fg: "#fecaca" } : c.lowBalance ? { bg: "#78350f", fg: "#fde68a" } : { bg: "rgba(255,255,255,0.12)", fg: "#fff" };
  const style: React.CSSProperties = { background: tone.bg, color: tone.fg, borderRadius: 999, padding: "2px 10px", fontWeight: 600, textDecoration: "none", fontSize: 12, whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 6 };
  if (c.admin) {
    return (
      <Link href="/account/billing" title="Admin account — usage is logged but never charged" style={style}>
        Admin · unlimited
      </Link>
    );
  }
  const team = c.member ? "Team " : "";
  const days = dailyDealsDaysLeft(c.spendableBasePence, c.dailyDealsPence ?? 0);
  const daysText = daysWords(days);
  // The chip shares one row with the nav, the pill and Feedback: on a phone
  // the days (and the rolled-over amount) are in the title, not the strip.
  return (
    <Link href="/account/usage" title={chipTitle({ teamName: c.member?.teamName, days, rolledOverPence: c.rolledOverPence }, formatGbp)} aria-label={chipAria({ team: Boolean(c.member), totalPence: c.totalPence, days, rolledOverPence: c.rolledOverPence }, formatGbp)} style={style}>
      {`${team}${formatGbp(c.totalPence)}`}
      {daysText && <span className="hidden sm:inline">{` · ${daysText}`}</span>}
    </Link>
  );
}
