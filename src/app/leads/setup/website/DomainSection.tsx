import { registrarConfigured } from "@/lib/domains/registrar";
import { memberDomainView } from "@/lib/domains/member-view";
import { createLiveStore, liveDomainEngine } from "@/lib/domains/store-server";
import type { WebsiteRow } from "@/lib/websites/store-server";
import { DomainPicker } from "./DomainPicker";

/**
 * Batch 33: the web address part of a live website's setup page: the picker
 * (for a live site with no address yet, whether it was approved a minute ago
 * or last month), or where the address has got to. Server side: it reads the
 * site's own domain row (the site comes from who is signed in) and shows plain
 * words only: never a price, a registrar reference or an error.
 */
export async function DomainSection({ site }: { site: WebsiteRow }) {
  if (site.status !== "live") return null;
  const store = createLiveStore();
  const [row, released] = await Promise.all([store.domainForSite(site.id), store.releasedBefore(site.id)]);
  const view = memberDomainView({ siteStatus: site.status, row: row ? { status: row.status, name: row.name } : null, releasedBefore: released, buyingOn: registrarConfigured() });

  switch (view.kind) {
    case "choose": {
      const offer = await liveDomainEngine().offerNames({ websiteId: site.id });
      if (!offer.ok) {
        if (offer.reason === "not_configured") return null;
        return <p className="mt-6 text-sm text-muted-foreground">We can&rsquo;t suggest a web address just now. Please check back later.</p>;
      }
      return <DomainPicker names={offer.names} again={view.again} />;
    }
    case "setting_up":
      return (
        <div className="mt-6 rounded-lg border border-border p-4 text-sm">
          <p className="font-medium text-foreground">Setting up {view.name}</p>
          <p className="mt-1 text-muted-foreground">This usually takes under an hour. Your website keeps working at its current address, and we email you when the new one is live.</p>
        </div>
      );
    case "live":
      return (
        <div className="mt-6 rounded-lg border border-border p-4 text-sm">
          <p className="font-medium text-foreground">Your web address is live</p>
          <p className="mt-1">
            <a href={view.address} className="font-medium underline underline-offset-2" target="_blank" rel="noreferrer">
              {view.address}
            </a>
          </p>
          <p className="mt-1 text-muted-foreground">The old address sends visitors here, so links you have already shared keep working.</p>
        </div>
      );
    case "waiting":
      return (
        <div className="mt-6 rounded-lg border border-border p-4 text-sm">
          <p className="font-medium text-foreground">Waiting for Stayful</p>
          <p className="mt-1 text-muted-foreground">You chose {view.name}. We are setting it up and will email you when it is live. Your website keeps working at its current address.</p>
        </div>
      );
    default:
      return null;
  }
}
