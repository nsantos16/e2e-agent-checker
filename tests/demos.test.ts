import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Job } from '../src/jobs.ts';
import { getVoiceSettings, saveVoiceSettings, voiceReadiness } from '../src/voice-settings.ts';
import { generateDemo, waitForDemo, cancelDemo, listDemos, demoFile } from '../src/demos.ts';
import { childEnvironment } from '../src/environments.ts';
import { emptyUsage } from '../src/usage.ts';
import { speechUsage } from '../src/speech.ts';
import { alignTimeline } from '../src/replay-timeline.ts';
import { command } from '../src/process.ts';
import { packageNarration, videoDuration } from '../src/demo-media.ts';
import { cachedText } from '../src/narration-cache.ts';

async function fixture(body: (job: Job, dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'checker-demo-')),
    previous = process.env.E2E_STATE_DIR;
  process.env.E2E_STATE_DIR = join(dir, 'state');
  const replay = join(dir, 'replay');
  mkdirSync(replay);
  const video = join(replay, 'verification.mp4');
  writeFileSync(video, 'silent recording');
  writeFileSync(
    join(replay, 'timeline.json'),
    JSON.stringify({
      version: 1,
      clock: 'wall',
      closedAt: 10000,
      steps: [
        {
          position: 1,
          title: 'Open the saved note',
          status: 'passed',
          startedAt: 2500,
          endedAt: 4500,
        },
        {
          position: 2,
          title: 'Save changes',
          status: 'failed',
          startedAt: 5000,
          endedAt: 9000,
        },
      ],
    }),
  );
  const job: Job = {
    id: 'test-demo',
    project: 'LOCAL',
    caseId: 1,
    worktree: '',
    role: 'qa',
    status: 'done',
    outcome: 'fail',
    runDir: dir,
    video,
    replay: { status: 'failed' },
    createdAt: new Date().toISOString(),
    log: [],
  };
  try {
    await body(job, dir);
  } finally {
    if (previous === undefined) delete process.env.E2E_STATE_DIR;
    else process.env.E2E_STATE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}
function setup() {
  const { revision, speechCredentialRef, ...options } = getVoiceSettings();
  return saveVoiceSettings({
    expectedRevision: revision,
    options: { ...options, enabled: true },
    speechCredentialRef: 'env://TEST_DEMO_SPEECH_SECRET',
  });
}
function dependencies() {
  const calls = { text: 0, speech: 0, package: 0, credential: 0 };
  const deps: NonNullable<Parameters<typeof generateDemo>[2]> = {
    duration: async () => 10,
    credential: async () => {
      calls.credential++;
      return 'private-api-key-value';
    },
    text: async (candidates, options, dir, signal) => {
      calls.text++;
      assert.equal(options.textModel, 'gpt-6-luna');
      signal.throwIfAborted();
      assert.ok(JSON.stringify(candidates).length < 12000);
      assert.ok(candidates.find((c) => c.position === 2)?.choices.every((c) => c.includes('failed')));
      return {
        choices: candidates.map((c) => ({ position: c.position, variant: 1 })),
        usage: {
          ...emptyUsage('codex', 'complete'),
          inputTokens: 100,
          outputTokens: 30,
        },
        models: ['gpt-6-luna'],
      };
    },
    speech: async (text) => {
      calls.speech++;
      return {
        pcm: Buffer.alloc(4800, 3),
        transcript: text,
        usage: speechUsage({
          id: 'fixture',
          usage: {
            input_token_details: { text_tokens: 20, cached_tokens: 0 },
            output_token_details: { audio_tokens: 50, text_tokens: 10 },
          },
        }),
      };
    },
    package: async (_, dir) => {
      calls.package++;
      writeFileSync(join(dir, 'narrated.mp4'), 'narrated fixture');
      return { durationSeconds: 12 };
    },
  };
  return { calls, deps };
}
test('shared cache waits cancel independently and preflight failures can retry without uncertain billing', async () =>
  fixture(async () => {
    const text = { choices: [], usage: emptyUsage('fixture', 'complete'), models: ['gpt-6-luna'] };
    let finish!: (value: typeof text) => void, entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    let calls = 0;
    const generate = async () => {
      calls++;
      entered();
      return new Promise<typeof text>((resolve) => (finish = resolve));
    };
    const first = cachedText({ content: 'shared' }, generate);
    await started;
    const abort = new AbortController();
    const second = cachedText({ content: 'shared' }, generate, abort.signal);
    abort.abort(new Error('Stop this waiter'));
    await assert.rejects(second, /Stop this waiter/);
    finish(text);
    assert.equal((await first).hit, false);
    assert.equal((await cachedText({ content: 'shared' }, generate)).hit, true);
    assert.equal(calls, 1);
    await assert.rejects(
      cachedText({ content: 'preflight' }, async () => {
        throw Object.assign(new Error('Login needed'), { beforeGeneration: true });
      }),
    );
    assert.equal((await cachedText({ content: 'preflight' }, async () => text)).hit, false);
  }));
test('voice settings default off, persist, reject secrets/stale updates and scrub configured credentials from all child workers', async () =>
  fixture(async () => {
    const initial = getVoiceSettings();
    assert.equal(initial.enabled, false);
    const next = setup();
    assert.equal(getVoiceSettings().revision, next.settings.revision);
    assert.equal(voiceReadiness().speech.status, 'missing');
    assert.throws(() =>
      saveVoiceSettings({
        expectedRevision: initial.revision,
        options: initial,
        speechCredentialRef: 'raw-secret',
      }),
    );
    assert.throws(
      () =>
        saveVoiceSettings({
          expectedRevision: initial.revision,
          options: {
            enabled: false,
            textModel: 'gpt-6-luna',
            speechModel: 'gpt-realtime-2.1-mini',
            voice: 'marin',
          },
          speechCredentialRef: null,
        }),
      /changed/,
    );
    assert.equal(childEnvironment({ TEST_DEMO_SPEECH_SECRET: 'secret', KEEP: 'yes' }).TEST_DEMO_SPEECH_SECRET, undefined);
    assert.equal(childEnvironment({ KEEP: 'yes' }).KEEP, 'yes');
  }));
test('demo manifests and media cannot follow symlinks outside the selected run', async () =>
  fixture(async (job, dir) => {
    const external = mkdtempSync(join(tmpdir(), 'checker-demo-external-'));
    try {
      const id = 'a'.repeat(64),
        target = join(dir, 'demos', id);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(external, 'secrets.json'), JSON.stringify({ status: 'ready', privateKey: 'never-expose' }));
      symlinkSync(join(external, 'secrets.json'), join(target, 'demo.json'));
      assert.deepEqual(listDemos(job), []);
      assert.equal(demoFile(job, id, 'usage'), undefined);
      rmSync(join(dir, 'demos'), { recursive: true });
      symlinkSync(external, join(dir, 'demos'));
      await assert.rejects(generateDemo(job, {}), /outside this run/);
      assert.equal(existsSync(join(external, id)), false);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  }));
test('off makes zero model, speech or credential calls; enabled generation is cached, truthful and independent of test outcome', async () =>
  fixture(async (job, dir) => {
    const { calls, deps } = dependencies();
    const off = await generateDemo(job, {}, deps);
    assert.equal(off.status, 'silent');
    assert.deepEqual(calls, { text: 0, speech: 0, package: 0, credential: 0 });
    setup();
    const explicitOff = await generateDemo(job, { voice: { enabled: false } }, deps);
    assert.equal(explicitOff.id, off.id);
    const [a, b] = await Promise.all([generateDemo(job, {}, deps), generateDemo(job, {}, deps)]);
    assert.equal(a.id, b.id);
    const ready = await waitForDemo(job, a.id);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.synthetic, true);
    assert.match(ready.segments![0].text, /Verification result: failed/);
    assert.match(ready.segments!.at(-1)!.text, /step 2 failed/);
    assert.equal(ready.options.enabled, true);
    assert.equal(job.outcome, 'fail');
    assert.equal(job.status, 'done');
    assert.equal(readFileSync(job.video!, 'utf8'), 'silent recording');
    assert.equal(calls.text, 1);
    assert.equal(calls.speech, 3);
    await generateDemo(job, { retry: true }, deps);
    listDemos(job);
    assert.equal(calls.speech, 3);
    assert.equal(calls.text, 1);
    const newVoice = await generateDemo(job, { voice: { voice: 'cedar' } }, deps);
    const alternate = await waitForDemo(job, newVoice.id);
    assert.equal(alternate.status, 'ready');
    assert.equal(alternate.textCacheHit, true);
    assert.equal(calls.text, 1);
    const sameEvidence = { ...job, id: 'another-run' };
    const reused = await generateDemo(sameEvidence, {}, deps);
    await waitForDemo(sameEvidence, reused.id);
    assert.equal(calls.text, 1);
    assert.equal(calls.speech, 6, 'same spoken content/options reuses speech across runs');
    const report = readFileSync(join(dir, 'demos', a.id, 'demo.json'), 'utf8');
    assert.doesNotMatch(report, /private-api-key-value|TEST_DEMO_SPEECH_SECRET|env:\/\//);
    assert.equal(demoFile(job, a.id, '../secret'), undefined);
  }));
test('errors retain cached paid stages; retry packaging never regenerates speech; missing timing/credentials never call a model', async () =>
  fixture(async (job) => {
    const { calls, deps } = dependencies();
    const missing = await generateDemo(job, { voice: { enabled: true } }, deps);
    const unavailable = await waitForDemo(job, missing.id);
    assert.equal(unavailable.error?.code, 'CREDENTIAL_UNAVAILABLE');
    assert.equal(calls.text, 0);
    setup();
    const pack = deps.package;
    deps.package = async () => {
      throw Object.assign(new Error('sensitive diagnostic'), {
        code: 'MEDIA_FAILED',
      });
    };
    await generateDemo(job, { retry: true }, deps);
    const failed = await waitForDemo(job, missing.id);
    assert.equal(failed.status, 'error');
    assert.doesNotMatch(JSON.stringify(failed), /sensitive diagnostic/);
    assert.equal(calls.speech, 3);
    deps.package = pack;
    await generateDemo(job, { retry: true }, deps);
    assert.equal((await waitForDemo(job, missing.id)).status, 'ready');
    assert.equal(calls.speech, 3);
    rmSync(join(job.runDir!, 'replay/timeline.json'));
    const noTiming = await generateDemo(job, {}, deps);
    assert.equal((await waitForDemo(job, noTiming.id)).error?.code, 'TIMING_UNAVAILABLE');
    assert.equal(calls.speech, 3);
  }));
test('cancellation and uncertain provider failure never automatically rebill or change verification', async () =>
  fixture(async (job) => {
    setup();
    const { calls, deps } = dependencies();
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    deps.speech = async (_text, _options, _key, signal) => {
      calls.speech++;
      entered();
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('private-api-key-value')), { once: true }));
    };
    const a = await generateDemo(job, {}, deps);
    await started;
    const cancelled = await cancelDemo(job, a.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.usageMayBeIncomplete, true);
    assert.equal(job.outcome, 'fail');
    assert.doesNotMatch(JSON.stringify(cancelled), /private-api-key-value/);
    await generateDemo(job, { retry: true }, deps);
    assert.equal((await waitForDemo(job, a.id)).error?.code, 'NARRATION_UNCERTAIN');
    assert.equal(calls.speech, 1);
  }));
test('spoken transcript mismatch fails closed and preserves speech usage', async () =>
  fixture(async (job) => {
    setup();
    const { deps, calls } = dependencies();
    const speech = deps.speech;
    deps.speech = async (...args) => ({
      ...(await speech(...args)),
      transcript: 'All checks passed.',
    });
    const a = await generateDemo(job, {}, deps);
    const result = await waitForDemo(job, a.id);
    assert.equal(result.error?.code, 'TRANSCRIPT_MISMATCH');
    assert.equal(result.speechUsage.length, 1);
    assert.equal(calls.package, 0);
    assert.equal(demoFile(job, a.id, 'video'), undefined);
  }));
test('real ffmpeg packaging yields audible AAC, captions and an H.264 MP4 with step-boundary holds', async () =>
  fixture(async (job, dir) => {
    const made = await command('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=320x240:r=25:d=2',
      '-an',
      '-c:v',
      'libx264',
      job.video!,
    ]);
    assert.equal(made.code, 0);
    const original = readFileSync(job.video!);
    const target = join(dir, 'media');
    mkdirSync(target);
    for (let i = 0; i < 2; i++) {
      const pcm = Buffer.alloc(48000 * 2);
      for (let n = 0; n < pcm.length / 2; n++) pcm.writeInt16LE(Math.round(12000 * Math.sin((n / 24000) * Math.PI * 2 * 440)), n * 2);
      writeFileSync(join(target, `speech-${i}.pcm`), pcm);
    }
    const result = await packageNarration(
      job.video!,
      target,
      [
        {
          position: 1,
          startSeconds: 0,
          endSeconds: 1,
          text: 'Recorded step one passed.',
        },
        {
          position: 2,
          startSeconds: 1,
          endSeconds: 2,
          text: 'Recorded step two failed.',
        },
      ],
      AbortSignal.timeout(30000),
    );
    assert.equal(result.durationSeconds, 4.56);
    const mp4 = join(target, 'narrated.mp4');
    assert.ok((await videoDuration(mp4)) >= 4.5);
    const probe = await command('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', mp4]);
    const streams = JSON.parse(probe.stdout).streams;
    assert.ok(streams.some((s: any) => s.codec_name === 'h264'));
    assert.ok(streams.some((s: any) => s.codec_name === 'aac'));
    assert.ok(streams.some((s: any) => s.codec_name === 'mov_text'));
    assert.match(readFileSync(join(target, 'captions.vtt'), 'utf8'), /00:00:02.280 --> 00:00:04.560/);
    assert.deepEqual(readFileSync(job.video!), original);
    const decoded = join(target, 'decoded.pcm');
    assert.equal((await command('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-vn', '-f', 's16le', decoded])).code, 0);
    const samples = readFileSync(decoded);
    let energy = 0;
    for (let n = 0; n < samples.length; n += 2) energy += samples.readInt16LE(n) ** 2;
    assert.ok(Math.sqrt(energy / (samples.length / 2)) > 1000, 'packaged audio is audible, not an empty track');
    assert.ok(existsSync(join(target, 'narration.m4a')));
    const timing = alignTimeline(
      {
        version: 1,
        clock: 'wall',
        closedAt: 10000,
        steps: [
          {
            position: 1,
            title: 'Open',
            startedAt: 9000,
            endedAt: 9500,
            status: 'failed',
          },
        ],
      },
      2,
    );
    assert.equal(timing[0].startSeconds, 1);
    assert.equal(timing[0].endSeconds, 1.5);
  }));
