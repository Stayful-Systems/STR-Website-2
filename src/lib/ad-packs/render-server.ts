import 'server-only';

import { Sandbox } from '@vercel/sandbox';
import { adPackFetchImage } from './files-server';
import { enqueueRender as enqueueCore, loadRendererFiles, runRenderQueue as runCore, type EnqueueResult, type RenderDeps, type RenderReport, type SandboxFactory, type SandboxLike } from './render-core.ts';
import { createLiveRenderStore, createLiveStorage, readRenderSettings, readSandboxCpuSecondPence } from './render-store-server.ts';
import { createLiveStore } from './store-server.ts';
import { synthesise } from './voice-server';

export type { EnqueueResult, RenderReport, RenderLine } from './render-core.ts';
export type { AdVideoReady, RenderRow, RenderState } from './render-store.ts';
export { parseAdVideo } from './render-store.ts';

/**
 * Batch 38b: the real wiring of the notice video's render worker
 * (render-core.ts, which has the order, the codes and the cost rule).
 *
 *   runRenderQueue({dry, limit})       one pass of the cron worker (/api/internal/ad-pack-renders)
 *   enqueuePackRender({packId, version, voiceKey})
 *                                      queue the render of a stored pack version (insert-if-missing; never throws)
 *
 * Needs, in the environment: ELEVENLABS_API_KEY (voice) and Vercel Sandbox
 * access. On Vercel the sandbox authenticates with the deployment's OIDC token
 * on its own. Anywhere else (a local run, a preview that has no token) set
 * VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID together and they are
 * passed to the SDK. No secret is ever put in the sandbox, in a row or in a log.
 *
 * The route needs `ad-render/**` in the function bundle: next.config.ts
 * outputFileTracingIncludes has '/api/internal/ad-pack-renders'.
 */

/** Explicit sandbox credentials, only when all three are set (otherwise the SDK uses OIDC). */
function sandboxCredentials(): { token: string; teamId: string; projectId: string } | null {
  const token = process.env.VERCEL_TOKEN?.trim();
  const teamId = process.env.VERCEL_TEAM_ID?.trim();
  const projectId = process.env.VERCEL_PROJECT_ID?.trim();
  return token && teamId && projectId ? { token, teamId, projectId } : null;
}

const joinPath = (base: string, rel: string) => `${base.replace(/\/+$/, '')}/${rel}`;

function wrapSandbox(sandbox: Sandbox): SandboxLike {
  const base = sandbox.cwd;
  return {
    id: sandbox.name,
    async writeFiles(files) {
      await sandbox.writeFiles(files.map((f) => ({ path: joinPath(base, f.path), content: f.content })));
    },
    async run(cmd) {
      const started = Date.now();
      try {
        const res = await sandbox.runCommand({
          cmd: cmd.cmd,
          args: cmd.args,
          cwd: base,
          ...(cmd.sudo ? { sudo: true } : {}),
          ...(cmd.env ? { env: cmd.env } : {}),
          timeoutMs: cmd.timeoutMs,
        });
        const stderr = (await res.stderr()).slice(-2000);
        // Only ffprobe's JSON is read back from stdout (the other commands' output is never kept).
        const stdout = cmd.cmd === 'ffprobe' ? (await res.stdout()).slice(0, 200_000) : undefined;
        return { exitCode: res.exitCode, stderr, ...(stdout !== undefined ? { stdout } : {}), timedOut: res.exitCode !== 0 && Date.now() - started >= cmd.timeoutMs - 1000 };
      } catch {
        return { exitCode: -1, stderr: '', timedOut: Date.now() - started >= cmd.timeoutMs - 1000 };
      }
    },
    async readFile(path) {
      const buf = await sandbox.readFileToBuffer({ path: joinPath(base, path) });
      return buf ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : null;
    },
    async stop() {
      await sandbox.stop();
      try {
        await sandbox.delete();
      } catch {
        // already gone (a sandbox that is not persistent is removed when it stops)
      }
    },
  };
}

const createSandbox: SandboxFactory = async ({ vcpus, timeoutMs }) => {
  const creds = sandboxCredentials();
  const sandbox = await Sandbox.create({
    ...(creds ?? {}),
    resources: { vcpus },
    timeout: timeoutMs,
    // apt and pip need the internet; nothing secret is in the sandbox, and it is stopped after every render.
    networkPolicy: 'allow-all',
    persistent: false,
    tags: { app: 'ad-pack-render' },
  });
  return wrapSandbox(sandbox);
};

function realDeps(): RenderDeps {
  const packs = createLiveStore();
  return {
    packs,
    renders: createLiveRenderStore(),
    sandbox: createSandbox,
    synth: (i) => synthesise({ voiceKey: i.voiceKey, lines: i.lines, packId: i.packId }),
    storage: createLiveStorage(),
    fetchImage: adPackFetchImage,
    rendererFiles: () => loadRendererFiles(),
    sandboxCpuSecondPence: readSandboxCpuSecondPence,
    renderSettings: readRenderSettings,
    now: () => new Date(),
    // A pack id, a code and seconds: never an address, a text or a body.
    log: (event, f) => console.error(`[ad-packs] ${event}`, f.packId ?? '-', f.code ?? '-', f.seconds ?? '-'),
  };
}

export function runRenderQueue(opts: { dry?: boolean; limit?: number } = {}): Promise<RenderReport> {
  return runCore(realDeps(), opts);
}

export function enqueuePackRender(input: { packId: string; version: number; voiceKey: string }): Promise<EnqueueResult> {
  return enqueueCore(createLiveRenderStore(), input);
}
