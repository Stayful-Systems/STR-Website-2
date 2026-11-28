"use client";

import { useEffect, useRef, useState } from "react";
import { useAdsActions } from "./ActionsContext";
import { INK, SOFT, btnSecondary, card, fieldCls } from "./ui";
import {
  AREA_LABEL,
  COVERAGE_ADD_LABEL,
  COVERAGE_ADD_PLACEHOLDER,
  COVERAGE_ALL_GROUP,
  COVERAGE_AREAS_HELP,
  COVERAGE_AREAS_TITLE,
  COVERAGE_FULL,
  COVERAGE_NONE_YET,
  COVERAGE_UK_HELP,
  COVERAGE_UK_TITLE,
  COVERAGE_YOURS_GROUP,
  addCoverageKey,
  areaPreviewView,
  coverageAddOptions,
  coverageCountText,
  coverageStart,
  type AreaPreviewView,
  type CoverageFormMode,
  type CoverageFormOption,
} from "./view";
import { MAX_COVERAGE_AREAS } from "@/lib/ad-packs/coverage";

/**
 * Batch 55 step 5 (Phase 3): "Where do you want to find landlords?" on the lead database route. Two big choices,
 * "Anywhere in the UK" (picked to begin with) and "Choose areas" (1 to 10 places from the same list as before, the
 * customer's own areas first). It sends `coverage` and one `coverageArea` per chosen place; ops.ts checks them.
 * The Academy form never shows this.
 */

export type CoveragePickerProps = {
  formId: string;
  options: CoverageFormOption[];
  /** The customer's own areas (keys), from the lead database, in their order. */
  suggested: string[];
  initialMode: CoverageFormMode;
  initialKeys: string[];
  /** Tells the form whether the choice can be sent, and whether it differs from where it started. */
  onState: (s: { ready: boolean; dirty: boolean }) => void;
};

export function CoveragePicker(p: CoveragePickerProps) {
  const { areaPreview } = useAdsActions();
  const start = coverageStart({ mode: p.initialMode, keys: p.initialKeys, suggested: p.suggested, options: p.options });
  const [mode, setMode] = useState<CoverageFormMode>(start.mode);
  const [keys, setKeys] = useState<string[]>(start.keys);
  const [preview, setPreview] = useState<AreaPreviewView | null>(null);
  const asked = useRef(0);
  const first = keys[0] ?? "";
  const labelOf = (k: string) => p.options.find((o) => o.areaKey === k)?.label ?? k;
  const { yours, rest } = coverageAddOptions(p.options, p.suggested, keys);
  const { onState } = p;

  useEffect(() => {
    const dirty = mode !== start.mode || keys.join("|") !== start.keys.join("|");
    const ready = mode === "uk" || (keys.length > 0 && preview?.ok === true);
    onState({ ready, dirty });
    // start is derived from the props, which do not change while the form is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, keys, preview, onState]);

  /** Ask for the figure preview of the first chosen place (only from a handler or once on mount, never in render). */
  function loadPreview(key: string) {
    const mine = ++asked.current;
    if (!key) return;
    areaPreview(key)
      .then((view) => { if (mine === asked.current) setPreview(view); })
      .catch(() => { if (mine === asked.current) setPreview(areaPreviewView({ error: "not_enough_data" })); });
  }

  function apply(nextMode: CoverageFormMode, nextKeys: string[]) {
    const nextFirst = nextMode === "areas" ? (nextKeys[0] ?? "") : "";
    const nowFirst = mode === "areas" ? first : "";
    setMode(nextMode);
    setKeys(nextKeys);
    if (nextFirst !== nowFirst) {
      setPreview(null);
      loadPreview(nextFirst);
    }
  }

  useEffect(() => {
    if (start.mode === "areas" && start.keys[0]) loadPreview(start.keys[0]);
    // Once, for a form that opens on chosen areas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pickAreas() {
    apply("areas", keys.length === 0 && start.preset.length > 0 ? start.preset : keys);
  }

  return (
    <fieldset className={`${card} min-w-0 space-y-3`}>
      <legend className={`float-left mb-1 w-full text-xl font-bold ${INK}`}>{AREA_LABEL}</legend>
      <input type="hidden" name="coverage" value={mode} />
      {mode === "areas" ? keys.map((k) => <input key={k} type="hidden" name="coverageArea" value={k} />) : null}
      <div className="clear-both space-y-3">
        <Choice name={`${p.formId}-coverage-choice`} picked={mode === "uk"} title={COVERAGE_UK_TITLE} help={COVERAGE_UK_HELP} onPick={() => apply("uk", keys)} />
        <Choice name={`${p.formId}-coverage-choice`} picked={mode === "areas"} title={COVERAGE_AREAS_TITLE} help={COVERAGE_AREAS_HELP} onPick={pickAreas} />
      </div>

      {mode === "areas" ? (
        <div className="space-y-3">
          {keys.length > 0 ? (
            <ul className="space-y-2">
              {keys.map((k) => (
                <li key={k} className="flex min-h-12 items-center justify-between gap-3 rounded-xl border border-border bg-white px-3 py-2">
                  <span className={`min-w-0 break-words text-base ${INK}`}>{labelOf(k)}</span>
                  <button type="button" onClick={() => apply(mode, keys.filter((x) => x !== k))} className={`${btnSecondary} min-h-11 shrink-0 px-3 py-2`} aria-label={`Remove ${labelOf(k)}`}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={`text-base ${SOFT}`}>{COVERAGE_NONE_YET}</p>
          )}
          <p className={`text-base ${SOFT}`} aria-live="polite">{keys.length >= MAX_COVERAGE_AREAS ? COVERAGE_FULL : coverageCountText(keys.length)}</p>
          {keys.length < MAX_COVERAGE_AREAS ? (
            <div>
              <label htmlFor={`${p.formId}-coverage-add`} className={`block text-base font-semibold ${INK}`}>{COVERAGE_ADD_LABEL}</label>
              <select id={`${p.formId}-coverage-add`} value="" onChange={(e) => apply(mode, addCoverageKey(keys, e.target.value))} className={fieldCls}>
                <option value="">{COVERAGE_ADD_PLACEHOLDER}</option>
                {yours.length > 0 ? (
                  <optgroup label={COVERAGE_YOURS_GROUP}>
                    {yours.map((o) => <option key={o.areaKey} value={o.areaKey}>{o.label}</option>)}
                  </optgroup>
                ) : null}
                <optgroup label={COVERAGE_ALL_GROUP}>
                  {rest.map((o) => <option key={o.areaKey} value={o.areaKey}>{o.label}</option>)}
                </optgroup>
              </select>
            </div>
          ) : null}
          {first ? <p className={`text-base leading-relaxed ${SOFT}`} aria-live="polite">{preview ? preview.text : "Checking that place…"}</p> : null}
        </div>
      ) : null}
    </fieldset>
  );
}

function Choice(p: { name: string; picked: boolean; title: string; help: string; onPick: () => void }) {
  return (
    <label className={`flex min-h-14 cursor-pointer items-start gap-3 rounded-xl border-2 p-4 ${p.picked ? "border-[#3b5735] bg-[#3b5735]/5" : "border-border bg-white"}`}>
      <input type="radio" name={p.name} checked={p.picked} onChange={p.onPick} className="mt-1 size-6 shrink-0 accent-[#3b5735]" />
      <span>
        <span className={`block text-lg font-semibold ${INK}`}>{p.title}</span>
        <span className={`mt-1 block text-base leading-relaxed ${SOFT}`}>{p.help}</span>
      </span>
    </label>
  );
}
