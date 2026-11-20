import { leadDbProblems } from "@/lib/leaddb/store";
import { leadDbMessage } from "@/lib/leaddb/messages";
import { LeadDbRetry } from "./LeadDbRetry";

const WHEN = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });

/**
 * Batch 32: website leads that did not reach an operator's lead database
 * (failed, or stuck for over an hour), from the last 14 days. Lead id, owner,
 * the error in plain English, attempts: never a landlord's details.
 */
export async function LeadDbFailuresPanel() {
  const rows = await leadDbProblems();
  return (
    <section className="mt-6 space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Lead database pushes that need a look</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Website leads that failed to reach the owner&apos;s lead database account, or have been waiting over an hour, from the last 14 days.
          Retry shows what it would do before it does anything.
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">Nothing failed or stuck.</p>
      ) : (
        <table className="w-full text-left text-xs">
          <thead className="text-muted-foreground">
            <tr><th className="py-1 pr-3 font-medium">Lead</th><th className="pr-3 font-medium">Owner</th><th className="pr-3 font-medium">State</th><th className="pr-3 font-medium">Problem</th><th className="pr-3 font-medium">Attempts</th><th className="pr-3 font-medium">Last change</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.leadId} className="border-t border-border align-top">
                <td className="py-2 pr-3 font-mono">{r.leadId.slice(0, 8)}</td>
                <td className="pr-3">{r.ownerEmail ?? r.ownerId.slice(0, 8)}</td>
                <td className="pr-3">{r.status === "failed" ? "Failed" : "Stuck"}</td>
                <td className="pr-3">{r.code ? <>{leadDbMessage(r.code)} <span className="font-mono text-muted-foreground">({r.code})</span></> : "—"}</td>
                <td className="pr-3">{r.attempts}</td>
                <td className="pr-3">{WHEN.format(new Date(r.updatedAt))}</td>
                <td><LeadDbRetry leadId={r.leadId} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
