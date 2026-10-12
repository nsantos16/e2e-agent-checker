import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lastJsonObject, runClaude } from './claude.ts';
import { statePath } from './login.ts';

// Stage 2: an agent writes a Playwright spec from the explore run and stabilises it against the same build.

export type CodifyResult = { specPath: string; attempts: number; outcome: 'passed' | 'failed-as-expected' | 'could-not-stabilize'; failingStep: number | null; notes?: string };

const root = new URL('..', import.meta.url).pathname;
import { requireFrontendRepo } from './config.ts';

export const specLocation = (runDir: string, project: string, caseId: number) => {
  const runId = runDir.split('/').pop()!;
  const specDir = join(root, 'e2e/generated', runId);
  return { specDir, specFile: `${project}-${caseId}.spec.ts`, specPath: join(specDir, `${project}-${caseId}.spec.ts`) };
};

// Points scripts/try-spec.sh (and replay) at a slot. Values only, no secrets: the session file path, not its contents.
export const writeReplayEnv = (runDir: string, specDir: string, specFile: string, base: string, slot: string, role: string) =>
  writeFileSync(
    join(runDir, 'replay.env'),
    [`E2E_SPEC_DIR='${specDir}'`, `E2E_SPEC_FILE='${specFile}'`, `E2E_BASE_URL='${base}'`, `E2E_STORAGE_STATE='${statePath(slot, role)}'`].join('\n') + '\n',
  );

export const codify = async (opts: { project: string; caseId: number; runDir: string; base: string; slot: string; role: string; model: string; maxAttempts?: number; log?: (l: string) => void }) => {
  const dir = join(opts.runDir, 'codify');
  mkdirSync(dir, { recursive: true });
  const { specDir, specFile, specPath } = specLocation(opts.runDir, opts.project, opts.caseId);
  mkdirSync(specDir, { recursive: true });
  writeReplayEnv(opts.runDir, specDir, specFile, opts.base, opts.slot, opts.role);

  const fill = (s: string) =>
    s
      .replaceAll('{{CASE_PATH}}', join(root, 'fixtures/qase', `${opts.project}-${opts.caseId}.json`))
      .replaceAll('{{REPORT_PATH}}', join(opts.runDir, 'explore/report.json'))
      .replaceAll('{{ACTIONS_PATH}}', join(opts.runDir, 'explore/actions.js'))
      .replaceAll('{{APP_CONTEXT_PATH}}', join(root, 'context/sample-app.md'))
      .replaceAll('{{requireFrontendRepo()}}', requireFrontendRepo())
      .replaceAll('{{SPEC_PATH}}', specPath)
      .replaceAll('{{RUN_DIR}}', opts.runDir)
      .replaceAll('{{PROJECT}}', opts.project)
      .replaceAll('{{CASE_ID}}', String(opts.caseId))
      .replaceAll('{{MAX_ATTEMPTS}}', String(opts.maxAttempts ?? 8));
  const prompt = fill(readFileSync(join(root, 'prompts/codify-case.md'), 'utf8'));
  writeFileSync(join(dir, 'prompt.md'), prompt);

  const outcome = await runClaude({
    prompt,
    cwd: root,
    model: opts.model,
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'],
    allowedTools: ['Read', 'Glob', 'Grep', `Write(/${specDir}/**)`, `Edit(/${specDir}/**)`, 'Bash(./scripts/try-spec.sh:*)', `Bash(${root}scripts/try-spec.sh:*)`],
    addDirs: [requireFrontendRepo()],
    transcriptPath: join(dir, 'transcript.jsonl'),
    log: opts.log,
  });
  const result = lastJsonObject<CodifyResult>(outcome.resultText);
  writeFileSync(join(dir, 'result.json'), result ? JSON.stringify(result, null, 2) : outcome.resultText);
  writeFileSync(join(dir, 'metrics.json'), JSON.stringify(outcome.metrics, null, 2));
  if (existsSync(specPath)) copyFileSync(specPath, join(dir, specFile));
  return { result, metrics: outcome.metrics, specPath, specDir, specFile };
};
