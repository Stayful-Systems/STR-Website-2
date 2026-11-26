import { r2rNoticeFor } from "@/lib/marketplace/r2r-notice";

/**
 * Deal feed: the rent-to-rent permission notice, plain text, shown on a rental only
 * (nothing is drawn for a sale). Used on the deal sheet; the full-analysis panel shows the same words.
 */
export function R2rPermissionNotice({ kind, className = "" }: { kind: string | null | undefined; className?: string }) {
  const text = r2rNoticeFor(kind);
  if (!text) return null;
  return (
    <p role="note" className={`rounded-md border border-border bg-muted/40 p-2.5 text-xs text-foreground ${className}`}>
      {text}
    </p>
  );
}
