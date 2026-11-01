import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { Job } from './jobs.ts';
import type { StorageSettings } from './settings.ts';

export type CleanupReport = {
  at: string;
  removed: { id: string; bytes: number }[];
  skipped: { id: string; reason: string }[];
  failed: { id: string; reason: string }[];
};
const active = (job: Job) => ['queued', 'running', 'cancelling'].includes(job.status);
// A run owns one immediate child of each managed root. Never follow links or accept
// an arbitrary job path, even when it happens to contain a directory named runs.
function managedChild(root: string, path: string) {
  const absolute = resolve(path),
    parent = resolve(root);
  if (dirname(absolute) !== parent || absolute === parent) throw new Error('Outside the managed cache directory');
  if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new Error('Cache root is a symbolic link');
  if (existsSync(absolute)) {
    if (lstatSync(absolute).isSymbolicLink() || realpathSync(absolute) !== join(realpathSync(parent), basename(absolute)))
      throw new Error('Cache directory is a symbolic link');
    if (!lstatSync(absolute).isDirectory()) throw new Error('Cache path is not a directory');
  }
  return absolute;
}
function bytesAt(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return 0;
  return stat.isDirectory() ? readdirSync(path).reduce((sum, name) => sum + bytesAt(join(path, name)), 0) : stat.size;
}
export function cleanRunCaches(
  jobs: Job[],
  settings: StorageSettings,
  roots: { runs: string; generated: string },
  now = Date.now(),
  activeArtifactDirs: string[] = [],
): CleanupReport {
  const report: CleanupReport = { at: new Date(now).toISOString(), removed: [], skipped: [], failed: [] };
  if (settings.runCacheAfterDays === null) return report;
  const cutoff = now - settings.runCacheAfterDays * 86400000;
  const busy = jobs.filter(active);
  const protectedSources = new Set(busy.map((job) => job.replayOf));
  const protectedPaths = new Set([
    ...activeArtifactDirs.map((path) => resolve(path)),
    ...busy.flatMap((job) => [job.runDir, job.specSelection?.sourceRun].filter((path): path is string => !!path).map((path) => resolve(path))),
  ]);
  for (const job of jobs) {
    if (!job.runDir || job.cacheClearedAt) continue;
    if (active(job) || protectedSources.has(job.id) || protectedPaths.has(resolve(job.runDir))) {
      report.skipped.push({ id: job.id, reason: 'Run, dependent verification or demo generation is active' });
      continue;
    }
    const finished = Date.parse(job.finishedAt ?? job.createdAt);
    if (!Number.isFinite(finished) || finished > cutoff) continue;
    try {
      const run = managedChild(roots.runs, job.runDir);
      const generated = managedChild(roots.generated, join(roots.generated, basename(run)));
      const paths = [run, generated];
      let bytes = 0;
      for (const path of paths) {
        if (!existsSync(path)) continue;
        bytes += bytesAt(path);
        rmSync(path, { recursive: true, force: true });
      }
      job.cacheClearedAt = report.at;
      report.removed.push({ id: job.id, bytes });
    } catch (error) {
      report.failed.push({ id: job.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}
