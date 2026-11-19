/**
 * Batch 31: a website address that is not live: paused, still in preview,
 * never existed, or a page the site does not have. Neutral on purpose: it
 * names nobody and links nowhere, the same as a retired funnel link.
 */
export default function SiteNotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-white px-6 text-center text-neutral-800">
      <div className="max-w-md">
        <h1 className="text-xl font-semibold">This page is not available</h1>
        <p className="mt-3 text-sm text-neutral-600">The page you were sent to has been taken down or the address is incomplete. Please check with whoever sent it to you.</p>
      </div>
    </main>
  );
}
