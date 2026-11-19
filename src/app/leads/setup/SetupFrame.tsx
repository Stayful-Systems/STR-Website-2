import Link from "next/link";
import { SETUP_STEPS } from "@/lib/management/setup";

/**
 * Batch 22f: one screen per step — where you are, the way back, the step.
 */
export function SetupFrame({ step, back, title, intro, children, progress }: { step: 0 | 1 | 2 | 3 | "live"; back: string | null; title: string; intro?: React.ReactNode; children: React.ReactNode; progress?: { labels: readonly string[]; current: number } }) {
  const current = step === "live" ? 4 : step;
  // Batch 31: the website setup has its own five steps; it passes them here instead of the lead form's.
  const bar = progress ? progress.labels.map((label, i) => ({ step: i + 1, label })) : SETUP_STEPS.map((s) => ({ step: s.step, label: s.label }));
  const at = progress ? progress.current : current;
  const caption = progress ? `Step ${progress.current} of ${progress.labels.length} · ${progress.labels[progress.current - 1] ?? ""}` : step === "live" ? "All set" : step === 0 ? "Before you start" : `Step ${step} of 3 · ${SETUP_STEPS[step].label}`;
  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-2xl px-4 pb-16 sm:px-6">
        <nav aria-label="Setup progress" className="mb-5">
          <ol className="flex items-center gap-1.5">
            {bar.map((s) => (
              <li key={s.step} className="flex-1">
                <span className={`block h-1.5 rounded-full ${s.step < at ? "bg-primary" : s.step === at ? "bg-primary/60" : "bg-muted"}`} />
                <span className="sr-only">{s.label}{s.step < at ? " (done)" : s.step === at ? " (this step)" : ""}</span>
              </li>
            ))}
          </ol>
          <p className="mt-2 text-xs text-muted-foreground">{caption}</p>
        </nav>
        {back ? (
          <Link href={back} className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground">
            ← Back
          </Link>
        ) : null}
        <h1 className="mt-2 text-2xl font-semibold text-foreground">{title}</h1>
        {intro ? <div className="mt-2 text-sm text-muted-foreground">{intro}</div> : null}
        <div className="mt-6">{children}</div>
      </div>
    </main>
  );
}
