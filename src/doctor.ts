import { Effect } from 'effect';
import { runEffect } from './runtime/effect.ts';
import { commandEffect, ProcessRunnerLive } from './process.ts';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { getEnvironment, getTestUser } from './environments.ts';
import { config, frontendRepo, qaseToken } from './config.ts';

// Checks everything a dev needs on their machine, with the command that fixes each gap. Never prompts or reads secrets.

export type Check = { name: string; ok: boolean; required: boolean; detail: string; fix?: string };

const run = (cmd: string, args: string[]) =>
  commandEffect(cmd, args, { timeoutMs: 15_000 }).pipe(
    Effect.map(({ code, stdout, stderr }) => (code === 0 ? (stdout || stderr).trim() : undefined)),
    Effect.catch(() => Effect.succeed(undefined)),
  );

const versionAtLeast = (v: string | undefined, min: number[]) => {
  const parts = v
    ?.match(/(\d+)\.(\d+)(?:\.(\d+))?/)
    ?.slice(1)
    .map(Number);
  if (!parts) return false;
  for (let i = 0; i < min.length; i++) if ((parts[i] ?? 0) !== min[i]) return (parts[i] ?? 0) > min[i];
  return true;
};

export const runDoctorEffect = (environmentId = 'local', userId?: string) =>
  Effect.gen(function* () {
    const environment = getEnvironment(environmentId),
      user = getTestUser(environment, userId);
    const refs = [user.usernameRef, user.passwordRef, user.totpRef].filter(Boolean) as string[];
    const needsOp = refs.some((ref) => ref.startsWith('op://')) && !process.env.OP_SERVICE_ACCOUNT_TOKEN;
    const [claude, op, opAccounts, ffmpeg, gh] = yield* Effect.all(
      [
        run('claude', ['--version']),
        run('op', ['--version']),
        run('op', ['account', 'list', '--format', 'json']),
        run(config.ffmpeg, ['-version']),
        run('gh', ['--version']),
      ],
      { concurrency: 5 },
    );
    const repo = frontendRepo();
    const opHasAccount = (() => {
      try {
        return (JSON.parse(opAccounts ?? '[]') as { url: string }[]).some((a) => a.url === config.onePasswordAccount);
      } catch {
        return false;
      }
    })();
    return [
      ...refs
        .filter((ref) => ref.startsWith('env://'))
        .map((ref) => ({
          name: `Credential variable ${ref.slice(6)}`,
          required: true,
          ok: !!process.env[ref.slice(6)],
          detail: process.env[ref.slice(6)] ? 'configured' : 'missing',
          fix: 'Set this variable in the checker process environment and restart the app.',
        })),
      {
        name: 'Node.js ≥ 24',
        required: true,
        ok: versionAtLeast(process.versions.node, [24]),
        detail: process.versions.node,
        fix: 'Install Node 24+ (the frontend pins 26)',
      },
      {
        name: 'sample-frontend checkout',
        required: environment.kind === 'worktree',
        ok: !!repo,
        detail: repo ?? 'not found',
        fix: 'Set "frontendRepo" in e2e-agent.local.json',
      },
      {
        name: 'Claude Code CLI (optional runtime)',
        required: false,
        ok: !!claude,
        detail: claude ?? 'not installed',
        fix: 'npm install -g @anthropic-ai/claude-code && claude (log in once)',
      },
      {
        name: '1Password CLI',
        required: needsOp,
        ok: !!op,
        detail: op ?? 'not installed',
        fix: 'brew install 1password-cli, then enable 1Password → Settings → Developer → Integrate with 1Password CLI',
      },
      {
        name: `1Password account ${config.onePasswordAccount}`,
        required: needsOp,
        ok: opHasAccount,
        detail: opHasAccount ? 'configured' : 'not signed in',
        fix: `op account add --address ${config.onePasswordAccount}`,
      },
      {
        name: 'Qase API token (optional import/sync)',
        required: false,
        ok: !!qaseToken(),
        detail: qaseToken() ? 'found' : 'missing',
        fix: `Create one at https://app.qase.io/user/api/token, then: security add-generic-password -s ${config.qase.keychainService} -a "$USER" -w`,
      },
      {
        name: 'Playwright Chromium',
        required: true,
        ok: existsSync(chromium.executablePath()),
        detail: existsSync(chromium.executablePath()) ? 'installed' : 'missing',
        fix: 'npm run setup',
      },
      {
        name: 'ffmpeg (video packaging)',
        required: true,
        ok: !!ffmpeg,
        detail: ffmpeg?.split('\n')[0] ?? 'not installed',
        fix: 'brew install ffmpeg',
      },
      {
        name: 'GitHub CLI ≥ 2.99 (publishing only)',
        required: false,
        ok: versionAtLeast(gh, [2, 99]),
        detail: gh?.split('\n')[0] ?? 'not installed',
        fix: 'brew install gh (or brew upgrade gh) && gh auth login',
      },
    ];
  });
export const runDoctor = (environmentId = 'local', userId?: string): Promise<Check[]> =>
  runEffect(runDoctorEffect(environmentId, userId).pipe(Effect.provide(ProcessRunnerLive)));

if (import.meta.url === `file://${process.argv[1]}`) {
  const checks = await runDoctor();
  for (const c of checks) console.log(`${c.ok ? '✅' : c.required ? '❌' : '⚠️ '} ${c.name}: ${c.detail}${c.ok ? '' : `\n   → ${c.fix}`}`);
  const missing = checks.filter((c) => !c.ok && c.required).length;
  console.log(missing ? `\n${missing} required item(s) missing.` : '\nReady. Start the app with: npm run app');
  process.exitCode = missing ? 1 : 0;
}
