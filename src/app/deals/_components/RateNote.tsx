"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import { changeRateHref } from "@/lib/marketplace/card-display";
import { resetRateAction } from "../actions";

/**
 * Batch 30: how the profit range was worked out, in one line under a card or
 * beside the range on a deal page: "Using 5.4%, today's average · change", or
 * "Using your 6% · change · Use today's average". Outside the card's own link
 * (a link inside a link is not one). Changing the rate changes it everywhere.
 */
export function RateNote({ line, rateSet, next, className = "" }: { line: string; rateSet: boolean; next?: string; className?: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <p className={`text-[11px] text-muted-foreground ${className}`}>
      {line} ·{" "}
      <Link href={changeRateHref(next ?? pathname ?? "/deals")} className="font-medium text-foreground underline-offset-2 hover:underline">
        change
      </Link>
      {rateSet && (
        <>
          {" "}
          ·{" "}
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              start(async () => {
                await resetRateAction();
                router.refresh();
              })
            }
            className="font-medium text-foreground underline-offset-2 hover:underline disabled:opacity-50"
          >
            Use today’s average
          </button>
        </>
      )}
    </p>
  );
}
