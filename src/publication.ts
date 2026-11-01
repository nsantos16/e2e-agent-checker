import { mkdtempSync, readFileSync, rmSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job } from './jobs.ts';
import { publishSchema } from './demo-contract.ts';
import { artifactPath } from './agent-view.ts';
import { demoFile, listDemos } from './demos.ts';
import { buildSessionSummary, renderSessionSummary } from './session-summary.ts';
import type { RunSession } from './sessions.ts';
import { command, type CommandOptions } from './process.ts';
import { digest, fail } from './local-state.ts';
type Execute = (name: string, args: string[], opts?: CommandOptions) => ReturnType<typeof command>;
const locks = new Map<string, Promise<unknown>>();
export async function publishEvidence(
  input: unknown,
  jobs: (Job | undefined)[],
  session?: RunSession,
  signal?: AbortSignal,
  execute: Execute = command,
) {
  const request = publishSchema.parse(input);
  const key = `${request.pr}:${request.sessionId ?? request.jobId}`;
  const prior = locks.get(key) ?? Promise.resolve();
  const pending = prior
    .catch(() => {})
    .then(async () => {
      signal?.throwIfAborted();
      const job = request.jobId ? (jobs.find((j) => j?.id === request.jobId) ?? fail('NOT_FOUND', 'Unknown run')) : undefined;
      if (!job && (!session || session.id !== request.sessionId)) fail('NOT_FOUND', 'Unknown session');
      const summary = session ? buildSessionSummary(session, jobs, '') : undefined;
      const comment = job && artifactPath(job, 'comment');
      if (job && !comment) fail('ARTIFACT_MISSING', 'This run has no completed per-run comment; use its session summary for partial work');
      const attachments: { job: Job; file: string; name: string }[] = [];
      for (const j of jobs) {
        if (!j || request.video === 'none' || (job && j.id !== job.id) || (session && !session.jobIds.includes(j.id))) continue;
        const silent = artifactPath(j, 'video');
        if (!silent) continue;
        const demo = request.video === 'narrated' ? listDemos(j).find((d) => d.status === 'ready') : undefined;
        const file = request.video === 'narrated' ? demo && demoFile(j, demo.id, 'video') : silent;
        if (!file) fail('ARTIFACT_MISSING', 'Generate a ready narrated demo before selecting narrated publication');
        attachments.push({
          job: j,
          file,
          name: `${j.project}-${j.caseId}-${j.id}-${request.video}.mp4`,
        });
      }
      if (attachments.length > 50)
        fail('INVALID_INPUT', 'GitHub supports up to 50 attachments; publish without videos or select a smaller explicit session');
      const videos = Object.fromEntries(attachments.map((a) => [a.job.id, a.name]));
      const body = summary
        ? renderSessionSummary(summary, videos)
        : readFileSync(comment!, 'utf8').replaceAll(
            job!.video ?? '\0',
            videos[job!.id]
              ? `[${request.video === 'narrated' ? 'MP4 with AI-generated voice narration' : 'Silent replay MP4'}](./${videos[job!.id]})`
              : 'Video not attached.',
          );
      const revision = digest({
        body,
        videos,
        artifacts: attachments.map((a) => digest(readFileSync(a.file))),
      });
      const marker = summary
        ? `<!-- e2e-session:${session!.id}:${revision} -->`
        : `<!-- e2e-job:${job!.id}${request.video === 'silent' ? '' : ':' + revision} -->`;
      const [, owner, repo, , number] = new URL(request.pr).pathname.split('/');
      const result = await execute('gh', ['api', `repos/${owner}/${repo}/issues/${number}/comments`, '--paginate', '--jq', '.[].body'], {
        signal,
        timeoutMs: 30_000,
      });
      if (result.code !== 0) fail('PUBLICATION_FAILED', 'Could not read existing PR comments');
      if (result.stdout.includes(marker)) return { alreadyPublished: true, pr: request.pr };
      const dir = mkdtempSync(join(tmpdir(), 'e2e-publish-'));
      try {
        const bodyPath = join(dir, 'comment.md');
        writeFileSync(bodyPath, body + `\n${marker}\n`);
        for (const a of attachments) copyFileSync(a.file, join(dir, a.name));
        const posted = await execute(
          'gh',
          ['pr', 'comment', request.pr, '--body-file', bodyPath, ...attachments.flatMap((a) => ['--attach', join(dir, a.name)])],
          { signal, cwd: dir, timeoutMs: 120_000 },
        );
        if (posted.code !== 0) fail('PUBLICATION_FAILED', 'PR publication failed; retry checks for the exact marker before posting');
        return { posted: posted.stdout.trim(), pr: request.pr };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  locks.set(key, pending);
  try {
    return await pending;
  } finally {
    if (locks.get(key) === pending) locks.delete(key);
  }
}
