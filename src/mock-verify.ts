import { Effect } from 'effect';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VerifyOptions } from './verify.ts';
import { prComment } from './verify.ts';
import { specLocation } from './codify.ts';
import { assertRunnable, type TestCase } from './cases.ts';
import { CaseRepository } from './runtime/repositories.ts';
import { createRunPricingEffect } from './pricing.ts';
import { getEnvironment, getTestUser } from './environments.ts';
import {
  captureBuild,
  compatibilityContext,
  specRequirements,
  selectSavedSpec,
  readSavedSpec,
  publishSavedSpec,
  type SavedSpecManifest,
  type SpecSelection,
} from './saved-specs.ts';
import { captureMockSources, type SourceSnapshot } from './mock-sources.ts';
import { authorMockSuiteEffect } from './mock-author.ts';
import { replayMockSuiteEffect } from './mock-replay.ts';
import { mockedCoverage, type MockSuite } from './mock-contract.ts';
import { atomicJson } from './network.ts';
import { noModelUsage } from './usage.ts';
import type { ExploreReport } from './explore.ts';

export const verifyMockSuiteEffect = (opts: VerifyOptions & { base: string; runDir: string; role: string }) =>
  Effect.gen(function* () {
    const runDir = opts.runDir;
    const testCase: TestCase = opts.replayOnly
      ? JSON.parse(readFileSync(join(opts.fromRun!, 'explore/case.json'), 'utf8'))
      : (opts.caseSnapshot ?? (yield* (yield* CaseRepository).get(opts.project, opts.caseId)));
    if (!opts.replayOnly) assertRunnable(testCase);
    if (testCase.project !== opts.project || testCase.id !== opts.caseId) throw new Error('INVALID_INPUT: case identity mismatch');
    const sources: SourceSnapshot = opts.replayOnly
      ? JSON.parse(readFileSync(join(opts.fromRun!, 'mock/sources.json'), 'utf8'))
      : captureMockSources(opts.mockSuite!, opts.worktree);
    if (!opts.replayOnly && opts.mockSourceFingerprint && opts.mockSourceFingerprint !== sources.fingerprint)
      throw Object.assign(new Error('SOURCE_CHANGED: relevant backend/schema inputs changed since submission'), { code: 'SOURCE_CHANGED' });
    const environment = opts.environment ?? getEnvironment(opts.environmentId);
    const context = {
      ...compatibilityContext(testCase, specRequirements(environment, getTestUser(environment, opts.role), opts.base, opts.worktree)),
      mock: { fingerprint: sources.fingerprint },
    };
    const testedBuild = captureBuild(opts.base, opts.worktree, opts.buildId);
    let selected;
    if (opts.replayOnly) {
      if (!opts.fromRun) throw new Error('ARTIFACT_MISSING: replay requires a source');
      // Explicit mock replay retains historical contracts, but never ignores artifact integrity.
      const manifest: SavedSpecManifest = JSON.parse(readFileSync(join(opts.fromRun, 'codify/manifest.json'), 'utf8'));
      const saved = readSavedSpec(opts.fromRun, {
        case: manifest.case,
        runtime: context.runtime,
        requirements: manifest.requirements,
        mock: manifest.mock,
      });
      if (typeof saved === 'string') throw new Error(`ARTIFACT_MISSING: incompatible mock replay: ${saved}`);
      selected = {
        saved,
        decision: {
          mode: 'replay',
          reason: 'explicit-mock-replay',
          sourceRun: opts.fromRun,
        } satisfies SpecSelection,
      };
    } else
      selected = selectSavedSpec(context, {
        forceFresh: opts.forceFresh,
        runDir,
      });
    const selection = selected.decision;
    const summary: Record<string, any> = {
      project: opts.project,
      caseId: opts.caseId,
      runDir,
      slot: opts.slot,
      target: opts.target,
      testedBuild,
      coverage: 'mocked',
      coverageExplanation: mockedCoverage,
      specSelection: selection,
      mock: {
        sourceFingerprint: sources.fingerprint,
        backendRevision: sources.revision,
      },
    };
    const save = () => atomicJson(join(runDir, 'summary.json'), summary);
    save();
    opts.onSelection?.(selection, testedBuild);
    for (const dir of ['mock', 'explore', 'codify']) mkdirSync(join(runDir, dir), { recursive: true });
    atomicJson(join(runDir, 'explore/case.json'), testCase);
    atomicJson(join(runDir, 'mock/sources.json'), sources);
    const spec = specLocation(runDir, opts.project, opts.caseId);
    mkdirSync(spec.specDir, { recursive: true });
    let suite: MockSuite;
    if (selected.saved) {
      const saved = selected.saved;
      if (!saved.mockArtifacts) throw new Error('ARTIFACT_MISSING: no mock artifacts');
      suite = saved.mockArtifacts.suite;
      atomicJson(join(runDir, 'mock/sources.json'), saved.mockArtifacts.sources);
      atomicJson(join(runDir, 'mock/suite.json'), suite);
      writeFileSync(spec.specPath, saved.spec);
      writeFileSync(join(runDir, 'codify', spec.specFile), saved.spec);
      mkdirSync(join(runDir, 'historical'), { recursive: true });
      atomicJson(join(runDir, 'historical/explore-report.json'), {
        ...saved.report,
        provenance: { historical: true, sourceRun: saved.runDir },
      });
      atomicJson(join(runDir, 'explore/report.json'), saved.report);
      // Retain a verifiable manifest for subsequent explicit replays of this replay.
      atomicJson(join(runDir, 'codify/manifest.json'), saved.manifest);
      summary.historicalExploration = {
        sourceRun: saved.runDir,
        verdict: saved.report.verdict,
      };
      summary.usage = noModelUsage(selection.mode === 'reuse' ? 'saved-spec' : 'replay');
      atomicJson(join(runDir, 'usage.json'), {
        usage: summary.usage,
        stages: {},
      });
    } else {
      opts.onStage?.('mock-author');
      const pricing = yield* createRunPricingEffect(runDir);
      const authored = yield* authorMockSuiteEffect(
        { ...opts, pricing, onMetrics: (m) => opts.onMetrics?.('codify', m) },
        sources,
        testCase,
      );
      suite = authored.suite;
      summary.codify = { metrics: authored.metrics };
    }
    summary.mock.scenarios = suite.scenarios.map(({ id, title, kind }) => ({
      id,
      title,
      kind,
    }));
    summary.mock.assumptions = suite.assumptions;
    summary.mock.unavailableContracts = suite.scenarios.flatMap((s) =>
      s.mocks.flatMap((m) =>
        m.responses.flatMap((r) => (r.unavailableContract ? [{ scenario: s.id, mock: m.id, reason: r.unavailableContract }] : [])),
      ),
    );
    save();
    const replay = yield* replayMockSuiteEffect(
      {
        runDir,
        label: `slot${opts.slot}`,
        ...spec,
        base: opts.base,
        role: opts.role,
        slot: opts.slot,
        signal: opts.signal,
        onReplay: () => opts.onStage?.('replay'),
        onPackage: () => opts.onStage?.('package'),
      },
      suite,
    );
    const verdict = replay.status === 'passed' ? 'pass' : replay.status === 'failed' ? 'fail' : 'blocked';
    const report: ExploreReport = {
      caseId: opts.caseId,
      verdict,
      notes: mockedCoverage,
      steps: testCase.steps.map(({ position }) => {
        const expected = suite.scenarios.filter((s) => s.steps.some((step) => step.position === position));
        const observations = expected.map((s) => {
          const result = replay.scenarios.find((r) => r.id === s.id)!;
          const step = result.steps?.find((st) => st.title.startsWith(`Step ${position}:`));
          return {
            id: s.id,
            verdict: !step ? 'blocked' : step.error ? 'fail' : 'pass',
            evidence: step?.error?.message ?? step?.title ?? result.error ?? 'Step not executed',
          };
        });
        return {
          position,
          verdict: observations.some((s) => s.verdict === 'fail')
            ? 'fail'
            : observations.every((s) => s.verdict === 'pass')
              ? 'pass'
              : 'blocked',
          evidence: observations.map((s) => `${s.id}: ${s.verdict}: ${s.evidence}`).join('\n'),
        };
      }),
    };
    summary.outcome = verdict;
    summary.verification = report;
    summary.replays = [{ slot: opts.slot, ...replay }];
    summary.spec = spec.specPath;
    atomicJson(join(runDir, 'verification.json'), {
      ...report,
      coverage: 'mocked',
      source: 'replay',
      scenarios: replay.scenarios,
      testedBuild,
    });
    if (!selected.saved)
      atomicJson(join(runDir, 'explore/report.json'), {
        ...report,
        source: 'mock-suite',
        explorationPerformed: false,
      });
    save();
    writeFileSync(join(runDir, 'pr-comment.md'), prComment(summary, report));
    if (selection.mode === 'author' && ['pass', 'fail'].includes(verdict)) publishSavedSpec(runDir, context, testedBuild);
    return summary;
  });
