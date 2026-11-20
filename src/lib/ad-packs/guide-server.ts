import 'server-only';

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GUIDE_DIR, GUIDE_STEPS } from './guide.ts';

/**
 * Batch 38 (Phase 9): which guide screenshots exist, so the screen never shows a
 * broken-image icon. Read from the filesystem on the server when the page is
 * made (next.config.ts lists the folder for /leads/ads, so the files are in the
 * serverless bundle). A missing folder or file is simply "no screenshot yet".
 */
export function availableGuideShots(root: string = process.cwd()): string[] {
  try {
    return GUIDE_STEPS.filter((s) => existsSync(join(root, GUIDE_DIR, `${s.id}.png`))).map((s) => s.id);
  } catch {
    return [];
  }
}
