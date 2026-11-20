import { packAdLine } from "@/lib/ad-packs/attribution-server";

/**
 * Batch 36: which of the operator's pack ads brought this lead. Read through
 * the service role and filtered by the account owner id the page already
 * resolved with leadScope, so another account never sees it. Shows nothing
 * when the owner has no approved ad pack, and nothing on any failure.
 */
export async function PackAdLine({ leadId, ownerId }: { leadId: string; ownerId: string }) {
  const view = await packAdLine(leadId, ownerId);
  if (view.kind === "hidden") return null;
  return (
    <p className="mt-1">
      <span
        className={
          view.kind === "matched"
            ? "rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success"
            : "rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
        }
      >
        {view.text}
      </span>
    </p>
  );
}
