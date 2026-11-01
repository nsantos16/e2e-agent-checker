import { Effect } from 'effect';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { replayEffect, type ReplayOptions } from './replay.ts';
import { commandEffect } from './process.ts';
import { config } from './config.ts';
import { atomicJson, readJson } from './network.ts';
import type { MockSuite } from './mock-contract.ts';

export const replayMockSuiteEffect = (opts: ReplayOptions, suite: MockSuite) =>
  Effect.gen(function* () {
    const scenarios = [];
    for (const scenario of suite.scenarios) {
      opts.signal?.throwIfAborted();
      const label = `${opts.label}-${scenario.id}`;
      const result = yield* replayEffect({
        ...opts,
        label,
        mockScenario: scenario.id,
        reuseAttempt: undefined,
        slowMo: 0,
      });
      const dir = join(opts.runDir, `replay-${label}`);
      scenarios.push({
        id: scenario.id,
        title: scenario.title,
        kind: scenario.kind,
        ...result,
        traffic: readJson(join(dir, 'mock-network.json')),
        dom: readJson(join(dir, 'mock-dom.json')),
      });
    }
    const aggregateDir = join(opts.runDir, `replay-${opts.label}`);
    mkdirSync(aggregateDir);
    const status = scenarios.some((s) => ['failed', 'timedOut'].includes(s.status))
      ? 'failed'
      : scenarios.every((s) => s.status === 'passed')
        ? 'passed'
        : 'unknown';
    const failed = scenarios.find((s) => s.status !== 'passed');
    const results = join(aggregateDir, 'results.json');
    atomicJson(results, { coverage: 'mocked', status, scenarios });
    // One downloadable trace bundle retains every scenario, including failures.
    const entries: Record<string, Uint8Array> = {};
    for (const s of scenarios) if (s.trace) entries[`${s.id}/trace.zip`] = readFileSync(s.trace);
    const trace = Object.keys(entries).length ? join(aggregateDir, 'traces.zip') : undefined;
    if (trace) writeFileSync(trace, zipSync(entries, { level: 0 }));
    let video: string | undefined;
    if (scenarios.every((s) => s.video && existsSync(s.video))) {
      // Concatenate already-normalized silent MP4s in scenario order. Missing footage
      // is reported, never substituted with another scenario's successful recording.
      const list = join(aggregateDir, 'videos.txt');
      writeFileSync(list, scenarios.map((s) => `file '${s.video!.replaceAll("'", "'\\''")}'`).join('\n'));
      const output = join(aggregateDir, 'verification.mp4');
      const packaged = yield* commandEffect(
        config.ffmpeg,
        ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', output],
        { signal: opts.signal },
      );
      if (packaged.code === 0) video = output;
    }
    return {
      status,
      exitCode: status === 'passed' ? 0 : 1,
      base: opts.base,
      scenarios,
      results,
      trace,
      video,
      steps: scenarios.flatMap((s) => s.steps ?? []),
      failedStep: failed ? `${failed.id}: ${failed.failedStep ?? failed.status}` : undefined,
      error: failed?.error,
      packagingError: video ? undefined : 'Complete suite video unavailable; inspect scenario artifacts.',
      wallMs: scenarios.reduce((n, s) => n + s.wallMs, 0),
      executionMs: scenarios.reduce((n, s) => n + s.executionMs, 0),
      provenance: {
        kind: 'replay' as const,
        independentRun: true,
        coverage: 'mocked',
      },
      avoidedExecutionMs: 0,
    };
  });
