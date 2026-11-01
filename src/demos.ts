import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Job } from './jobs.ts';
import { generateDemoSchema, type VoiceOptions } from './demo-contract.ts';
import { effectiveVoiceOptions, getVoiceSettings } from './voice-settings.ts';
import { digest, fail, readState, writeState } from './local-state.ts';
import { alignTimeline, type ReplayTimeline } from './replay-timeline.ts';
import { planNarration, type ScriptChoice, type TextResult } from './narration-text.ts';
import { normalizeSpeech, speechRates, synthesizeSpeech, type SpeechResult, type SpeechUsage } from './speech.ts';
import { packageNarration, videoDuration, type NarrationSegment } from './demo-media.ts';
import { resolveCredential } from './credentials.ts';
import { cachedText, cachedSpeech } from './narration-cache.ts';
import { scrubText } from './network.ts';

export type DemoArtifact = {
  id: string;
  jobId: string;
  options: VoiceOptions;
  createdAt: string;
  updatedAt: string;
  status: 'silent' | 'queued' | 'scripting' | 'speaking' | 'packaging' | 'ready' | 'error' | 'cancelled' | 'interrupted';
  progress: string;
  error?: { code: string; message: string };
  synthetic: boolean;
  segments?: NarrationSegment[];
  durationSeconds?: number;
  textUsage?: TextResult;
  speechUsage: SpeechUsage[];
  usageMayBeIncomplete?: boolean;
  textCacheHit?: boolean;
  speechCacheHits?: boolean[];
  rates: {
    text: {
      model: 'gpt-6-luna';
      input: number;
      cachedInput: number;
      output: number;
      perTokens: number;
      asOf: string;
      source: string;
    };
    speech: typeof speechRates;
  };
  limitations: string[];
};
type Dependencies = {
  text: typeof planNarration;
  speech: typeof synthesizeSpeech;
  package: typeof packageNarration;
  credential: typeof resolveCredential;
  duration: typeof videoDuration;
};
const dependencies: Dependencies = {
  text: planNarration,
  speech: synthesizeSpeech,
  package: packageNarration,
  credential: resolveCredential,
  duration: videoDuration,
};
const running = new Map<string, { controller: AbortController; promise: Promise<void>; runDir: string }>();
export const activeDemoRunDirs = () => [...running.values()].map((task) => task.runDir);
const dirFor = (job: Job, id: string) => {
  if (!job.runDir || !/^[a-f0-9]{64}$/.test(id)) fail('ARTIFACT_MISSING', 'Demo artifact is unavailable');
  const dir = join(job.runDir!, 'demos', id);
  // A replay/spec must not be able to redirect writes or manifest reads outside its run.
  for (const candidate of [join(job.runDir!, 'demos'), dir]) {
    if (existsSync(candidate) && !realpathSync(candidate).startsWith(realpathSync(job.runDir!) + '/'))
      fail('ARTIFACT_MISSING', 'Demo artifact is outside this run');
  }
  return dir;
};
const activeKey = (job: Job, id: string) => join(dirFor(job, id), 'demo.json');
const activeStatuses = new Set(['queued', 'scripting', 'speaking', 'packaging']);
export function listDemos(job: Job): DemoArtifact[] {
  if (!job.runDir || !existsSync(join(job.runDir, 'demos'))) return [];
  return readdirSync(join(job.runDir, 'demos'))
    .filter((name) => /^[a-f0-9]{64}$/.test(name))
    .flatMap((id) => {
      let file: string;
      try {
        file = activeKey(job, id);
      } catch {
        return [];
      }
      if (existsSync(file) && !realpathSync(file).startsWith(realpathSync(job.runDir!) + '/')) return [];
      const artifact = readState<DemoArtifact | null>(file, null);
      if (!artifact) return [];
      if (activeStatuses.has(artifact.status) && !running.has(file)) {
        artifact.status = 'interrupted';
        artifact.progress = 'Interrupted by server restart. Cached stages are retained.';
        artifact.usageMayBeIncomplete = true;
        writeState(file, artifact);
      }
      return [artifact];
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function demoFile(job: Job, id: string, kind: string): string | undefined {
  const dir = dirFor(job, id),
    demo = readState<DemoArtifact | null>(join(dir, 'demo.json'), null);
  if (!demo) return;
  const files: Record<string, string> = {
    video: 'narrated.mp4',
    audio: 'narration.m4a',
    captions: 'captions.vtt',
    script: 'script.json',
    usage: 'demo.json',
  };
  if (!files[kind] || (['video', 'audio', 'captions'].includes(kind) && demo.status !== 'ready')) return;
  const file = join(dir, files[kind]);
  if (!existsSync(file)) return;
  const real = realpathSync(file);
  return real.startsWith(realpathSync(job.runDir!) + '/') && statSync(real).isFile() ? real : undefined;
}
export const demoView = (job: Job, base = '') =>
  listDemos(job).map((d) => ({
    ...d,
    artifacts: Object.fromEntries(
      ['video', 'audio', 'captions', 'script', 'usage'].flatMap((kind) =>
        demoFile(job, d.id, kind) ? [[kind, `${base}/api/jobs/${job.id}/demos/${d.id}/${kind}`]] : [],
      ),
    ),
  }));
export function narrationCandidates(steps: ReturnType<typeof alignTimeline>): ScriptChoice[] {
  return steps.map((s) => {
    const status = s.status === 'passed' ? 'passed' : s.status === 'failed' ? 'failed' : 'incomplete';
    // Extractive choices only: model output cannot invent evidence or change a result.
    const title = scrubText(s.title)
      .replace(/[<>\r\n]/g, ' ')
      .split(/\s+/)
      .slice(0, 12)
      .join(' ')
      .slice(0, 120);
    const result = `Recorded step ${s.position} ${status}.`;
    return {
      position: s.position,
      choices: status === 'passed' ? [result, `Step ${s.position}. Recorded action: ${title}. This step passed.`] : [result],
    };
  });
}
const safeError = (e: unknown, aborted: boolean) => {
  const code = aborted ? 'CANCELLED' : String((e as any)?.code ?? 'NARRATION_FAILED');
  // Do not echo exceptions from providers, secrets or subprocesses to clients/reports.
  const messages: Record<string, string> = {
    CREDENTIAL_UNAVAILABLE: 'Configure a speech credential reference in Voice narration settings.',
    NARRATION_UNCERTAIN:
      'An earlier model request did not finish. It will not be sent again automatically; partial usage may be unavailable.',
    TRANSCRIPT_MISMATCH: 'Speech differed from the evidence script. Audio is cached but will not be published.',
    MEDIA_FAILED: 'Video packaging failed. Cached script and speech are retained; retry packaging.',
    TIMING_UNAVAILABLE: 'Recorded step timing is unavailable. Replay the saved spec to capture it; the original video remains usable.',
    DEMO_TOO_LONG: 'Voice demos support at most 12 recorded steps and 120 seconds of speech.',
    AUTH_REQUIRED: 'The selected script provider needs a native subscription login.',
    MODEL_UNAVAILABLE: 'The selected script model is unavailable. No other provider or model was substituted.',
    CANCELLED: 'Narration cancelled. Original evidence and test outcome are unchanged.',
    TIMEOUT: 'Narration exceeded its time limit. Cached stages are retained; partial request usage may be unavailable.',
  };
  return {
    code: /^[A-Z_]+$/.test(code) ? code : 'NARRATION_FAILED',
    message:
      messages[code] ?? 'Narration could not finish. Check model readiness, speech access and media tooling. Cached stages were retained.',
  };
};
export async function generateDemo(job: Job, input: unknown, deps: Dependencies = dependencies): Promise<DemoArtifact> {
  const request = generateDemoSchema.parse(input);
  if (['queued', 'running', 'cancelling'].includes(job.status))
    fail('INVALID_INPUT', 'Wait for verification to finish before generating a demo');
  if (!job.runDir || !job.video || !existsSync(job.video) || !realpathSync(job.video).startsWith(realpathSync(job.runDir) + '/'))
    fail('ARTIFACT_MISSING', 'No recorded replay video is available');
  const options = effectiveVoiceOptions(request.voice);
  const timeline = readState<ReplayTimeline | null>(join(dirname(job.video), 'timeline.json'), null);
  const videoHash = createHash('sha256').update(readFileSync(job.video)).digest('hex');
  const id = digest({
    version: 1,
    jobId: job.id,
    videoHash,
    timeline,
    outcome: job.outcome,
    replay: job.replay?.status,
    options,
  });
  const dir = dirFor(job, id),
    file = activeKey(job, id);
  const existing = listDemos(job).find((d) => d.id === id);
  if (existing && (!request.retry || running.has(file) || ['ready', 'silent'].includes(existing.status))) return existing;
  if (options.enabled && running.size >= 2) fail('NARRATION_BUSY', 'Two demos are already generating; wait for one to finish');
  const now = new Date().toISOString();
  const artifact: DemoArtifact = existing ?? {
    id,
    jobId: job.id,
    options,
    createdAt: now,
    updatedAt: now,
    status: options.enabled ? 'queued' : 'silent',
    progress: options.enabled ? 'Queued for narration' : 'Silent replay selected; no narration calls',
    synthetic: options.enabled,
    speechUsage: [],
    rates: {
      text: {
        model: 'gpt-6-luna',
        input: 0.1,
        cachedInput: 0.01,
        output: 0.5,
        perTokens: 1e6,
        asOf: '2026-11-01',
        source: 'https://developers.openai.com/api/docs/models/gpt-6-luna',
      },
      speech: speechRates,
    },
    limitations: [
      'Narration is derived from recorded step labels and results, not visual understanding.',
      'Timing is aligned to page close and recording duration; capture precision is approximate (about 250 ms).',
      'Frames may pause at step boundaries to finish narration; the original silent recording remains unchanged.',
    ],
  };
  mkdirSync(dir, { recursive: true });
  const save = () => {
    artifact.updatedAt = new Date().toISOString();
    writeState(file, artifact);
  };
  if (!options.enabled) {
    save();
    return artifact;
  }
  // Snapshot the credential reference privately in this closure; it is never passed to the text worker or saved with evidence.
  const ref = getVoiceSettings().speechCredentialRef;
  const controller = new AbortController(),
    signal = AbortSignal.any([controller.signal, AbortSignal.timeout(4 * 60_000)]);
  artifact.status = 'queued';
  artifact.error = undefined;
  save();
  const work = async () => {
    try {
      if (!timeline?.closedAt || !timeline.steps.length) fail('TIMING_UNAVAILABLE', 'Replay again to capture step timing');
      if (timeline.steps.length > 12) fail('DEMO_TOO_LONG', 'Narration supports at most 12 recorded steps');
      const duration = await deps.duration(job.video!, signal);
      const steps = alignTimeline(timeline, duration);
      if (
        steps.length !== timeline.steps.length ||
        new Set(steps.map((s) => s.position)).size !== steps.length ||
        steps.some((s, i) => i && s.startSeconds < steps[i - 1].endSeconds)
      )
        fail('TIMING_UNAVAILABLE', 'Recording timing is incomplete or overlapping');
      if (!ref) fail('CREDENTIAL_UNAVAILABLE', 'Speech is not configured');
      const key = await deps.credential(ref, signal);
      signal.throwIfAborted();
      let script = readState<{
        segments: NarrationSegment[];
        text: TextResult;
      } | null>(join(dir, 'script.json'), null);
      if (!script) {
        artifact.status = 'scripting';
        artifact.progress = 'Preparing a short evidence script';
        save();
        const candidates = narrationCandidates(steps);
        const attempt = join(dir, 'text-attempt.json');
        writeState(attempt, { startedAt: new Date().toISOString() });
        const planned = await cachedText(
          { candidates, textModel: options.textModel, effort: 'low' },
          (cacheDir) => deps.text(candidates, options, cacheDir, signal),
          signal,
        );
        const text = planned.result;
        artifact.textCacheHit = planned.hit;
        artifact.textUsage = text;
        save();
        const outcome = job.status === 'done' && ['pass', 'fail', 'blocked'].includes(job.outcome ?? '') ? job.outcome : 'incomplete';
        const intro = `AI-generated voice narration. Verification result: ${outcome === 'pass' ? 'passed' : outcome === 'fail' ? 'failed' : outcome}. Replay result: ${['passed', 'failed'].includes(job.replay?.status) ? job.replay.status : 'incomplete'}.`;
        const segments: NarrationSegment[] = [
          {
            position: 0,
            startSeconds: 0,
            endSeconds: steps[0].startSeconds,
            text: intro,
          },
        ];
        for (const [i, step] of steps.entries()) {
          const candidate = candidates[i];
          const variant = text.choices.find((c) => c.position === step.position)?.variant;
          const selected = Number.isInteger(variant) && variant! >= 0 && variant! < candidate.choices.length ? variant! : 0;
          segments.push({
            position: step.position,
            startSeconds: step.startSeconds,
            endSeconds: steps[i + 1]?.startSeconds ?? duration,
            text: candidate.choices[selected],
          });
        }
        // Bound the complete script independently of the text worker's selections.
        for (
          let i = segments.length - 1;
          segments
            .map((s) => s.text)
            .join(' ')
            .split(/\s+/).length > 180 && i > 0;
          i--
        )
          segments[i].text = candidates[i - 1].choices[0];
        script = { segments, text };
        writeState(join(dir, 'script.json'), script);
      }
      artifact.segments = script.segments;
      artifact.textUsage = script.text;
      save();
      for (const [i, segment] of script.segments.entries()) {
        signal.throwIfAborted();
        artifact.status = 'speaking';
        artifact.progress = `Generating speech ${i + 1} of ${script.segments.length}`;
        save();
        const metaPath = join(dir, `speech-${i}.json`),
          pcmPath = join(dir, `speech-${i}.pcm`),
          attempt = join(dir, `speech-${i}.attempt.json`);
        let meta = readState<Omit<SpeechResult, 'pcm'> | null>(metaPath, null);
        if (!meta || !existsSync(pcmPath)) {
          writeState(attempt, {
            startedAt: new Date().toISOString(),
            key: digest({
              text: segment.text,
              speechModel: options.speechModel,
              voice: options.voice,
            }),
          });
          const speech = await cachedSpeech(
            {
              text: segment.text,
              speechModel: options.speechModel,
              voice: options.voice,
            },
            () => deps.speech(segment.text, options, key, signal),
            signal,
          );
          const result = speech.result;
          (artifact.speechCacheHits ??= [])[i] = speech.hit;
          // Save usage even when transcript verification rejects audio; never silently regenerate it.
          writeFileSync(pcmPath, result.pcm, { mode: 0o600 });
          meta = { transcript: result.transcript, usage: result.usage };
          writeState(metaPath, meta);
        }
        artifact.speechUsage[i] = meta.usage;
        save();
        if (normalizeSpeech(meta.transcript) !== normalizeSpeech(segment.text)) fail('TRANSCRIPT_MISMATCH', 'Speech text differed');
        if (
          script.segments.slice(0, i + 1).reduce((total, _, index) => total + statSync(join(dir, `speech-${index}.pcm`)).size / 48000, 0) >
          120
        )
          fail('DEMO_TOO_LONG', 'Speech exceeded its duration budget');
      }
      signal.throwIfAborted();
      artifact.status = 'packaging';
      artifact.progress = 'Synchronizing speech with the recorded steps';
      save();
      const result = await deps.package(job.video!, dir, script.segments, signal);
      signal.throwIfAborted();
      artifact.durationSeconds = result.durationSeconds;
      artifact.status = 'ready';
      artifact.progress = 'Narrated MP4 ready';
      artifact.usageMayBeIncomplete = false;
      save();
    } catch (e) {
      artifact.error = safeError(signal.aborted && !controller.signal.aborted ? { code: 'TIMEOUT' } : e, controller.signal.aborted);
      artifact.status = controller.signal.aborted ? 'cancelled' : 'error';
      artifact.progress = artifact.error.message;
      artifact.usageMayBeIncomplete =
        ((e as any)?.beforeGeneration !== true && existsSync(join(dir, 'text-attempt.json')) && !existsSync(join(dir, 'script.json'))) ||
        readdirSync(dir).some((f) => f.endsWith('.attempt.json') && !existsSync(join(dir, f.replace('.attempt.json', '.json'))));
      save();
    }
  };
  // Register before starting work, so concurrent GETs cannot misclassify it as interrupted.
  const task = { controller, promise: Promise.resolve(), runDir: job.runDir! };
  running.set(file, task);
  task.promise = Promise.resolve()
    .then(work)
    .finally(() => running.delete(file));
  return structuredClone(artifact);
}
export async function cancelDemo(job: Job, id: string) {
  const task = running.get(activeKey(job, id));
  task?.controller.abort();
  await task?.promise;
  return listDemos(job).find((d) => d.id === id) ?? fail('NOT_FOUND', 'Unknown demo');
}
export async function shutdownDemos() {
  for (const task of running.values()) task.controller.abort();
  await Promise.all([...running.values()].map((t) => t.promise));
}
export async function waitForDemo(job: Job, id: string) {
  await running.get(activeKey(job, id))?.promise;
  return listDemos(job).find((d) => d.id === id)!;
}
