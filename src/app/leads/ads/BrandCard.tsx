"use client";

import { useRef, useState } from "react";
import { readableOn } from "@/lib/funnels/brand";
import { ColourPicker, colourFromFile } from "../setup/website/WebsiteSetup";
import { useAdsActions } from "./ActionsContext";
import { Alert, btnSecondary, card, fieldCls, INK, SOFT } from "./ui";
import {
  BRAND_CARD_HELP,
  BRAND_CARD_TITLE,
  BRAND_COLOUR_MISSING,
  BRAND_LOGO_ADD,
  BRAND_LOGO_ADDING,
  BRAND_LOGO_CHANGE,
  BRAND_LOGO_FAILED,
  BRAND_LOGO_HELP,
  BRAND_LOGO_LABEL,
  BRAND_LOGO_MAX_BYTES,
  BRAND_LOGO_NONE,
  BRAND_LOGO_SAVED,
  BRAND_LOGO_TOO_BIG,
  BRAND_NAME_LABEL,
  BRAND_NAME_MISSING,
} from "./view";

/**
 * Batch 55 (brand on the ads screen): the first card of making the ads, on the lead database route only. A lead
 * database customer has no website with their plan, so their company name, colour and logo are set here.
 *
 * The name and colour travel with the "Make my ads" form (inputs named companyName and brandColour) and are checked
 * and saved on the server (ops.ts generateOp, then the calculator's own save path). The logo is sent as soon as it is
 * chosen (uploadBrandLogo, the calculator's own upload path). The colour picker and the logo colour guess are the
 * setup's own. Nothing here holds or sends an id.
 */

export type BrandCardValue = { companyName: string; brandColour: string; logoUrl: string | null; uploading: boolean };

const validHex = (c: string) => /^#[0-9a-f]{6}$/i.test(c);

/** The two things Make my ads needs from this card, as the inline messages shown under each field. */
export function brandCardProblems(v: Pick<BrandCardValue, "companyName" | "brandColour">): { name: string | null; colour: string | null } {
  return { name: v.companyName.trim() === "" ? BRAND_NAME_MISSING : null, colour: validHex(v.brandColour) ? null : BRAND_COLOUR_MISSING };
}

export function BrandCard({ formId, initial, onChange }: { formId: string; initial: { companyName: string; brandColour: string | null; logoUrl: string | null }; onChange: (v: BrandCardValue) => void }) {
  const { uploadBrandLogo } = useAdsActions();
  const [value, setValue] = useState<BrandCardValue>({ companyName: initial.companyName, brandColour: initial.brandColour ?? "", logoUrl: initial.logoUrl, uploading: false });
  const [logoNote, setLogoNote] = useState<{ ok: boolean; text: string } | null>(null);
  const current = useRef(value);
  const pickedByHand = useRef(initial.brandColour !== null);
  const problems = brandCardProblems(value);

  function update(next: Partial<BrandCardValue>) {
    const merged = { ...current.current, ...next };
    current.current = merged;
    setValue(merged);
    onChange(merged);
  }

  async function addLogo(file: File | undefined) {
    if (!file) return;
    setLogoNote(null);
    if (file.size > BRAND_LOGO_MAX_BYTES) {
      setLogoNote({ ok: false, text: BRAND_LOGO_TOO_BIG });
      return;
    }
    // The colour of a freshly chosen logo is offered as the colour, unless one was already picked.
    if (!pickedByHand.current) {
      const c = await colourFromFile(file);
      if (c) update({ brandColour: c });
    }
    update({ uploading: true });
    try {
      const body = new FormData();
      body.set("logo", file);
      const out = await uploadBrandLogo(body);
      if (out.ok) {
        update({ logoUrl: out.url, uploading: false });
        setLogoNote({ ok: true, text: BRAND_LOGO_SAVED });
      } else {
        update({ uploading: false });
        setLogoNote({ ok: false, text: out.error });
      }
    } catch {
      update({ uploading: false });
      setLogoNote({ ok: false, text: BRAND_LOGO_FAILED });
    }
  }

  const strip = validHex(value.brandColour) ? value.brandColour : "#e5e3da";
  const name = value.companyName.trim();

  return (
    <section className={`${card} min-w-0 space-y-5`} aria-labelledby={`${formId}-brand-title`}>
      <div>
        <h2 id={`${formId}-brand-title`} className={`text-xl font-bold ${INK}`}>{BRAND_CARD_TITLE}</h2>
        <p className={`mt-1 text-base ${SOFT}`}>{BRAND_CARD_HELP}</p>
      </div>

      <div>
        <label htmlFor={`${formId}-company`} className={`block text-lg font-semibold ${INK}`}>{BRAND_NAME_LABEL}</label>
        <input
          id={`${formId}-company`}
          name="companyName"
          value={value.companyName}
          maxLength={80}
          autoComplete="organization"
          onChange={(e) => update({ companyName: e.target.value })}
          aria-invalid={problems.name ? true : undefined}
          aria-describedby={problems.name ? `${formId}-company-msg` : undefined}
          className={fieldCls}
        />
        {problems.name ? <p id={`${formId}-company-msg`} className="mt-2 text-base font-medium text-[#9b2c2c]">{problems.name}</p> : null}
      </div>

      <div>
        <ColourPicker
          value={value.brandColour}
          onPick={(hex) => {
            pickedByHand.current = true;
            update({ brandColour: hex });
          }}
        />
        <input type="hidden" name="brandColour" value={value.brandColour} />
        {problems.colour ? <p className="mt-2 text-base font-medium text-[#9b2c2c]">{problems.colour}</p> : null}
      </div>

      <div>
        <p className={`text-lg font-semibold ${INK}`}>{BRAND_LOGO_LABEL}</p>
        {value.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- the owner's own logo, already stored with us
          <img src={value.logoUrl} alt="Your logo" className="mt-2 h-12 max-w-[200px] object-contain" />
        ) : (
          <p className={`mt-1 text-base ${SOFT}`}>{BRAND_LOGO_NONE}</p>
        )}
        <label className={`${btnSecondary} mt-3 w-full cursor-pointer sm:w-auto has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2`}>
          {value.uploading ? BRAND_LOGO_ADDING : value.logoUrl ? BRAND_LOGO_CHANGE : BRAND_LOGO_ADD}
          <input type="file" accept="image/png,image/jpeg" className="sr-only" disabled={value.uploading} onChange={(e) => { void addLogo(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
        <p className={`mt-2 text-base ${SOFT}`}>{BRAND_LOGO_HELP}</p>
        {logoNote ? <div className="mt-3">{logoNote.ok ? <p role="status" className={`text-base ${INK}`}>{logoNote.text}</p> : <Alert>{logoNote.text}</Alert>}</div> : null}
      </div>

      <div aria-hidden className="flex min-h-14 items-center gap-3 rounded-xl px-4 py-3" style={{ background: strip, color: readableOn(strip) }}>
        {value.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- the owner's own logo, already stored with us
          <img src={value.logoUrl} alt="" className="h-8 max-w-[140px] rounded bg-white object-contain p-1" />
        ) : null}
        <span className="truncate text-base font-semibold">{name || BRAND_NAME_LABEL}</span>
      </div>
    </section>
  );
}
