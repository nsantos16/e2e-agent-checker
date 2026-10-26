import { Effect, Exit } from 'effect';
import { runEffect } from './runtime/effect.ts';
import { CheckerLive } from './runtime/services.ts';
import { commandEffect } from './process.ts';
import { readTestResult } from './test-results.ts';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeReplayEnv } from './codify.ts';
import { config } from './config.ts';
import { qualifyAttempt, type EvidenceContext, type VerifiedAttempt } from './attempt-evidence.ts';

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

export const toPrMp4Effect = (webm: string, mp4: string) =>
  Effect.gen(function* () {
    // H.264 + faststart so it plays inline on GitHub; capped at 1280 wide and CRF 30 to stay well under 10 MB.
    const converted = yield* commandEffect(
      config.ffmpeg,
      [
        '-y',
        '-loglevel',
        'error',
        '-xerror',
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
      {},
    );
    if (converted.code !== 0) throw new Error('Video conversion failed');
    return statSync(mp4).size;
  });
export const toPrMp4 = (webm: string, mp4: string, signal?: AbortSignal) =>
  runEffect(toPrMp4Effect(webm, mp4).pipe(Effect.provide(CheckerLive)), signal);

export type ReplayOptions = {
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
  reuseAttempt?: VerifiedAttempt;
  evidenceContext?: EvidenceContext;
  onReplay?: () => void;
  onPackage?: () => void;
};
export const replayEffect = (opts: ReplayOptions) =>
  Effect.gen(function* () {
    const outDir = join(opts.runDir, `replay-${opts.label}`);
    mkdirSync(outDir, { recursive: true });
    const started = Date.now();
    opts.signal?.throwIfAborted();
    const mp4 = join(outDir, 'verification.mp4');
    let fallbackReason: string | undefined;
    if (
      opts.reuseAttempt &&
      opts.evidenceContext &&
      (opts.slowMo === undefined || opts.slowMo === 0) &&
      opts.evidenceContext.runDir === opts.runDir &&
      opts.evidenceContext.specPath === join(opts.specDir, opts.specFile) &&
      opts.evidenceContext.base === opts.base &&
      opts.evidenceContext.slot === opts.slot &&
      opts.evidenceContext.role === opts.role &&
      opts.evidenceContext.storageState === (opts.storageState ?? join(root, '.state', `slot${opts.slot}-${opts.role}.json`))
    ) {
      const qualification = qualifyAttempt(opts.evidenceContext, opts.reuseAttempt);
      if (qualification.eligible) {
        opts.onPackage?.();
        const conversion = yield* Effect.exit(toPrMp4Effect(qualification.video, mp4));
        opts.signal?.throwIfAborted();
        // Recheck after packaging: a changing worktree or removed artifact must still fall back.
        const final = qualifyAttempt(opts.evidenceContext, opts.reuseAttempt);
        if (Exit.isSuccess(conversion) && final.eligible) {
          const { manifest, result } = final;
          return {
            status: result.status,
            failedStep: result.failedStep,
            error: result.error?.message?.split('\n').slice(0, 6).join('\n'),
            wallMs: Date.now() - started,
            executionMs: 0,
            avoidedExecutionMs: manifest.executionMs!,
            video: mp4,
            mp4Bytes: conversion.value,
            trace: final.trace,
            results: join(manifest.artifactDir, 'results.json'),
            diagnostics: manifest.artifacts.map((a) => a.path),
            provenance: {
              kind: 'stabilization' as const,
              independentRun: false,
              attemptId: manifest.attemptId,
              manifestPath: manifest.manifestPath,
              originalVideo: final.video,
              executionMs: manifest.executionMs!,
              slowMo: 0,
            },
            log: readFileSync(manifest.artifactDir + '.log', 'utf8').slice(-3000),
          };
        }
        fallbackReason = final.eligible ? 'recording-conversion-failed' : final.reason;
      } else fallbackReason = qualification.reason;
    }
    opts.signal?.throwIfAborted();
    opts.onReplay?.();
    writeReplayEnv(opts.runDir, opts.specDir, opts.specFile, opts.base, opts.slot, opts.role, opts.storageState);
    const executionStarted = Date.now();
    const { stdout, stderr, code } = yield* commandEffect('npx', ['playwright', 'test', '-c', 'playwright.config.ts', opts.specFile], {
      cwd: join(root, 'e2e'),
      env: {
        ...process.env,
        E2E_OBSERVATION_RUN_DIR: opts.runDir,
        E2E_SPEC_DIR: opts.specDir,
        E2E_OUTPUT_DIR: outDir,
        E2E_BASE_URL: opts.base,
        E2E_STORAGE_STATE: opts.storageState ?? join(root, '.state', `slot${opts.slot}-${opts.role}.json`),
        E2E_SLOWMO: String(opts.slowMo ?? 250),
        E2E_CAPTIONS: '1',
      },
      signal: opts.signal,
    });
    const executionMs = Date.now() - executionStarted;
    opts.signal?.throwIfAborted();
    writeFileSync(join(outDir, 'execution.log'), stdout + stderr);
    const testResult = readTestResult(outDir);
    const failedStep = testResult?.failedStep;
    const webm = findVideo(outDir);
    opts.onPackage?.();
    const mp4Bytes = webm ? yield* toPrMp4Effect(webm, mp4) : undefined;
    return {
      status: testResult?.status ?? 'unknown',
      failedStep,
      error: testResult?.error?.message?.split('\n').slice(0, 6).join('\n'),
      wallMs: Date.now() - started,
      executionMs,
      avoidedExecutionMs: 0,
      video: webm ? mp4 : undefined,
      mp4Bytes,
      trace: findTrace(outDir),
      results: existsSync(join(outDir, 'results.json')) ? join(outDir, 'results.json') : undefined,
      provenance: {
        kind: 'replay' as const,
        independentRun: true,
        fallbackReason,
        executionMs,
        exitCode: code,
        slowMo: opts.slowMo ?? 250,
      },
      log: stdout.slice(-3000),
    };
  });
export const replay = (opts: ReplayOptions) => runEffect(replayEffect(opts).pipe(Effect.provide(CheckerLive)), opts.signal);

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
