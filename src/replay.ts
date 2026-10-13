import { command } from './process.ts';
import { readTestResult } from './test-results.ts';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeReplayEnv } from './codify.ts';
import { config } from './config.ts';

// Stage 3: run the codified spec deterministically with video, then package an MP4 small enough for a PR.

const root = new URL('..', import.meta.url).pathname;

const findVideo = (dir: string): string | undefined => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findVideo(p);
      if (found) return found;
    } else if (entry.name.endsWith('.webm')) return p;
  }
  return undefined;
};

export const toPrMp4 = async (webm: string, mp4: string, signal?: AbortSignal) => {
  // H.264 + faststart so it plays inline on GitHub; capped at 1280 wide and CRF 30 to stay well under 10 MB.
  const converted = await command(
    config.ffmpeg,
    [
      '-y',
      '-loglevel',
      'error',
      '-i',
      webm,
      '-vf',
      'scale=1280:-2',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '30',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-an',
      mp4,
    ],
    { signal },
  );
  if (converted.code !== 0) throw new Error('Video conversion failed');
  return statSync(mp4).size;
};

export const replay = async (opts: {
  runDir: string;
  label: string;
  specDir: string;
  specFile: string;
  base: string;
  slot: string;
  role: string;
  storageState?: string;
  slowMo?: number;
  signal?: AbortSignal;
  onPackage?: () => void;
}) => {
  const outDir = join(opts.runDir, `replay-${opts.label}`);
  mkdirSync(outDir, { recursive: true });
  writeReplayEnv(opts.runDir, opts.specDir, opts.specFile, opts.base, opts.slot, opts.role, opts.storageState);
  const started = Date.now();
  const { stdout } = await command('npx', ['playwright', 'test', '-c', 'playwright.config.ts', opts.specFile], {
    cwd: join(root, 'e2e'),
    env: {
      ...process.env,
      E2E_OBSERVATION_RUN_DIR: opts.runDir,
      E2E_SPEC_DIR: opts.specDir,
      E2E_OUTPUT_DIR: outDir,
      E2E_BASE_URL: opts.base,
      E2E_STORAGE_STATE: opts.storageState ?? join(root, '.state', `slot${opts.slot}-${opts.role}.json`),
      E2E_SLOWMO: String(opts.slowMo ?? 250),
    },
    signal: opts.signal,
  });

  const testResult = readTestResult(outDir);
  const failedStep = testResult?.failedStep;
  const webm = findVideo(outDir);
  const mp4 = join(outDir, 'verification.mp4');
  opts.onPackage?.();
  const mp4Bytes = webm ? await toPrMp4(webm, mp4, opts.signal) : undefined;
  return {
    status: testResult?.status ?? 'unknown',
    failedStep,
    error: testResult?.error?.message?.split('\n').slice(0, 6).join('\n'),
    wallMs: Date.now() - started,
    video: webm ? mp4 : undefined,
    mp4Bytes,
    trace: findTrace(outDir),
    log: stdout.slice(-3000),
  };
};

const findTrace = (dir: string): string | undefined => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findTrace(p);
      if (found) return found;
    } else if (entry.name === 'trace.zip') return p;
  }
  return undefined;
};
