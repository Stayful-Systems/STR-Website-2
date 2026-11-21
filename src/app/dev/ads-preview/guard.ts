/**
 * Batch 38c: the development-only preview of the Facebook ads screens
 * (/dev/ads-preview) may open ONLY on a developer's own machine: not when the
 * app is built for production (NODE_ENV=production) and never on Vercel (any
 * deployment, preview or production). Anywhere else the route is a plain 404.
 *
 * Pure: no network, no database.
 */
export function devPreviewAllowed(env: { NODE_ENV?: string; VERCEL?: string }): boolean {
  return env.NODE_ENV !== 'production' && !env.VERCEL;
}
