/**
 * Test support for images.tsx (not a test: the `npm test` glob is *.test.ts).
 *
 * Node's type stripping does not compile JSX, so a test cannot import
 * images.tsx directly. This bundles it with esbuild (already a devDependency)
 * into a temp CommonJS file and loads that. next/og is left external (it is
 * resolved to its real file, because the bare specifier needs Next's
 * resolver); React's JSX runtime is bundled. The fonts are read from
 * process.cwd()/src/lib/ad-packs/fonts, so run from the repo root.
 */

import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export type ImagesModule = typeof import('./images.tsx');

let loaded: Promise<ImagesModule> | null = null;

export function loadImagesModule(): Promise<ImagesModule> {
  if (!loaded) {
    loaded = (async () => {
      const require = createRequire(import.meta.url);
      const ogPath = require.resolve('next/og.js');
      const outfile = path.join(mkdtempSync(path.join(tmpdir(), 'ad-images-')), 'images.cjs');
      await build({
        entryPoints: [fileURLToPath(new URL('./images.tsx', import.meta.url))],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node22',
        outfile,
        jsx: 'automatic',
        logLevel: 'silent',
        alias: { 'next/og': ogPath },
        external: [ogPath],
      });
      return require(outfile) as ImagesModule;
    })();
  }
  return loaded;
}
