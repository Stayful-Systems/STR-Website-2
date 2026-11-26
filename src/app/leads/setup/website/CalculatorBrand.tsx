"use client";

import { useActionState, useRef, useState } from "react";
import { BRAND_SWATCHES } from "@/lib/management/setup";
import type { SiteSettings } from "@/lib/websites/page-model";
import { BrandPreview } from "../BrandPreview";
import { ErrorLine, field, labelCls, primaryBtn } from "../ui";
import type { WebsiteState } from "./actions";
import { saveCalculatorBrandAction, uploadCalculatorLogoAction } from "./calculator-actions";
import { parseAreas } from "./steps";
import { ColourPicker, ImageUpload, colourFromFile } from "./WebsiteSetup";

const INITIAL: WebsiteState = {};

/**
 * Batch 55 (Part A), phase A5: the one screen for a calculator-only site.
 *
 * Only the seven things an owner can change: company name, logo, colour, areas,
 * fee, contact email and phone. No page text, no approval, no web address, no
 * photo, no about text. The pieces (colour picker, logo upload, the checks) are
 * the website setup's own; the logo goes up through the calculator's own action.
 * The site is found from who is signed in: nothing here holds or sends an id.
 */
export function CalculatorBrand({ settings }: { settings: SiteSettings }) {
  const [name, setName] = useState(settings.companyName);
  const [primary, setPrimary] = useState<string>(settings.brandColour ?? BRAND_SWATCHES[0]);
  const [logoColour, setLogoColour] = useState<string | null>(null);
  const [areas, setAreas] = useState(settings.areas.join("\n"));
  const picked = useRef(false);
  const [state, action, pending] = useActionState(saveCalculatorBrandAction, INITIAL);
  const parsed = parseAreas(areas);

  // The colour of a freshly chosen logo is offered as the colour, unless the owner has already picked one by hand.
  async function onLogoFile(file: File) {
    const c = await colourFromFile(file);
    if (!c) return;
    setLogoColour(c);
    if (!picked.current) setPrimary(c);
  }

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="space-y-6">
        <ImageUpload kind="logo" label="Logo (PNG or JPEG, under 1 MB)" current={settings.logoUrl} onFile={onLogoFile} upload={uploadCalculatorLogoAction} />
        <form action={action} className="space-y-5">
          <div>
            <label className={labelCls} htmlFor="companyName">
              Company name
            </label>
            <input id="companyName" name="companyName" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} className={field} autoComplete="organization" />
          </div>
          <ColourPicker
            value={primary}
            onPick={(hex) => {
              picked.current = true;
              setPrimary(hex);
            }}
          />
          {logoColour && logoColour.toLowerCase() !== primary.toLowerCase() ? (
            <button
              type="button"
              onClick={() => {
                picked.current = false;
                setPrimary(logoColour);
              }}
              className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
            >
              <span aria-hidden className="h-4 w-4 rounded-full border border-border" style={{ background: logoColour }} />
              Use the colour from my logo
            </button>
          ) : null}
          <input type="hidden" name="brandColour" value={primary} />

          <div>
            <label className={labelCls} htmlFor="areas">
              Areas you cover (one per line)
            </label>
            <textarea id="areas" name="areas" rows={5} required value={areas} onChange={(e) => setAreas(e.target.value)} className={field} placeholder={"Leeds\nHarrogate"} />
            <p className="mt-1 text-xs text-muted-foreground">{parsed.length === 0 ? "Add the areas you take landlords from." : `${parsed.length} area${parsed.length === 1 ? "" : "s"}: ${parsed.slice(0, 6).join(", ")}${parsed.length > 6 ? ", …" : ""}`}</p>
          </div>
          <div>
            <label className={labelCls} htmlFor="fee">
              Management fee (%)
            </label>
            <input id="fee" name="fee" required inputMode="decimal" defaultValue={settings.managementFeePct ?? ""} className={`${field} max-w-[8rem]`} placeholder="15" />
            <p className="mt-1 text-xs text-muted-foreground">Used in the income figures landlords see, exactly as you enter it.</p>
          </div>

          <div>
            <label className={labelCls} htmlFor="email">
              Contact email
            </label>
            <input id="email" name="email" type="email" required maxLength={254} defaultValue={settings.contactEmail} className={field} autoComplete="email" />
          </div>
          <div>
            <label className={labelCls} htmlFor="phone">
              Contact phone (UK)
            </label>
            <input id="phone" name="phone" type="tel" required maxLength={40} defaultValue={settings.contactPhone} className={field} autoComplete="tel" />
          </div>

          <ErrorLine state={state} />
          {state.saved ? (
            <p role="status" className="rounded-md border border-border bg-muted p-3 text-sm text-foreground">
              Saved. Your calculator now shows these details.
            </p>
          ) : null}
          <button type="submit" disabled={pending || !name.trim()} className={primaryBtn}>
            {pending ? "Saving…" : "Save changes"}
          </button>
        </form>
      </div>
      <BrandPreview companyName={name} logoUrl={settings.logoUrl} primary={primary} />
    </div>
  );
}
