import Link from "next/link";

/**
 * Batch 38c: the small pieces every Facebook ads screen shares: the page frame,
 * the big buttons, the calm notices and the bar that sticks to the bottom of a
 * phone. Plain markup only (no client code), so server and client components
 * can both use it.
 *
 * The rules these keep: text 16px or bigger, buttons at least 48px tall, one
 * column, nothing wider than a 360px phone.
 */

export const INK = "text-[#233221]";
export const SOFT = "text-[#46603f]";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#233221]";
/** Buttons without a width, for a row of two; `btnPrimary` is the full-width one. */
export const btnPrimaryBase = `inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-[#3b5735] px-5 py-3 text-center text-base font-semibold text-white shadow-sm transition active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
export const btnPrimary = `${btnPrimaryBase} w-full sm:w-auto sm:min-w-64`;
export const btnSecondary = `inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border-2 border-[#3b5735]/50 bg-card px-5 py-3 text-center text-base font-semibold text-[#2c4727] transition active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
export const card = "rounded-2xl border border-border bg-card p-4 sm:p-6";
export const fieldCls = `mt-2 block min-h-12 w-full rounded-xl border-2 border-border bg-white px-3 py-3 text-base ${INK} ${FOCUS}`;

/** The page: a title, one calm line, then the content. Leaves room under the content for the bar that sticks to a phone's bottom. */
export function PageFrame({ title, intro, back, compact = false, children }: { title: string; intro?: React.ReactNode; back?: { href: string; label: string }; compact?: boolean; children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-4xl space-y-6 px-4 pb-32 pt-2 sm:px-6 sm:pb-10">
        <div>
          {back ? (
            <Link href={back.href} className={`inline-flex min-h-11 items-center text-base font-medium underline underline-offset-4 ${INK}`}>
              {back.label}
            </Link>
          ) : null}
          <h1 className={`${compact ? "text-2xl" : "text-3xl"} font-bold leading-tight ${INK}`}>{title}</h1>
          {intro ? <p className={`mt-2 text-lg leading-relaxed ${SOFT}`}>{intro}</p> : null}
        </div>
        {children}
      </div>
    </main>
  );
}

/** A red-edged message for something that went wrong. */
export function Alert({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="rounded-xl border-2 border-destructive/50 bg-white p-4 text-base leading-relaxed text-[#7a2e2e]">
      {children}
    </p>
  );
}

/** A calm message for something that is happening, or what to do next. */
export function Calm({ children, live = true }: { children: React.ReactNode; live?: boolean }) {
  return (
    <p role={live ? "status" : undefined} className={`rounded-xl border border-border bg-white/70 p-4 text-base leading-relaxed ${INK}`}>
      {children}
    </p>
  );
}

/**
 * The main action, pinned to the bottom of a phone's screen (a normal block on a bigger one). The page frame leaves
 * room under the content so nothing is hidden behind it.
 */
export function StickyBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-6px_18px_rgba(35,50,33,0.12)] sm:static sm:z-auto sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none">
      <div className="mx-auto flex max-w-4xl flex-col gap-2 sm:max-w-none sm:items-start">{children}</div>
    </div>
  );
}

/** A turning ring, for "this is happening". */
export function Spinner() {
  return <span aria-hidden className="inline-block size-5 shrink-0 animate-spin rounded-full border-[3px] border-[#3b5735]/25 border-t-[#3b5735]" />;
}
