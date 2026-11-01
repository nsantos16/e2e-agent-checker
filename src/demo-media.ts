import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { command } from './process.ts';
import { config } from './config.ts';
import { fail } from './local-state.ts';

export type NarrationSegment = {
  position: number;
  startSeconds: number;
  endSeconds: number;
  text: string;
};
export async function videoDuration(path: string, signal?: AbortSignal) {
  const binary = process.env.E2E_FFPROBE ?? (config.ffmpeg.includes('/') ? join(dirname(config.ffmpeg), 'ffprobe') : 'ffprobe');
  const r = await command(binary, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path], {
    signal,
    timeoutMs: 15_000,
  });
  const duration = Number(r.stdout.trim());
  if (r.code !== 0 || !Number.isFinite(duration) || duration <= 0 || duration > 600)
    fail('MEDIA_UNAVAILABLE', 'A demo must have a playable recording of at most 10 minutes');
  return duration;
}
const timestamp = (seconds: number, separator = '.') => {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}${separator}${String(ms % 1000).padStart(3, '0')}`;
};
export async function packageNarration(video: string, dir: string, segments: NarrationSegment[], signal: AbortSignal) {
  const ff = async (args: string[]) => {
    const result = await command(config.ffmpeg, ['-y', '-loglevel', 'error', ...args], { cwd: dir, signal, timeoutMs: 120_000 });
    if (result.code !== 0) fail('MEDIA_FAILED', 'Narrated video packaging failed; cached audio was retained');
  };
  let offset = 0;
  const cues: { start: number; end: number; text: string }[] = [];
  for (const [i, segment] of segments.entries()) {
    signal.throwIfAborted();
    const pcm = join(dir, `speech-${i}.pcm`);
    const audioDuration = readFileSync(pcm).length / 48000;
    const recordedDuration = segment.endSeconds - segment.startSeconds;
    const duration = Math.ceil(Math.max(recordedDuration, audioDuration + 0.25, 0.1) * 25) / 25;
    // Freeze only at the end of this recorded step if speech needs more time. No re-enactment.
    await ff([
      '-ss',
      String(segment.startSeconds),
      '-t',
      String(Math.max(recordedDuration, 0.04)),
      '-i',
      video,
      '-f',
      's16le',
      '-ar',
      '24000',
      '-ac',
      '1',
      '-i',
      pcm,
      '-filter_complex',
      `[0:v]setpts=PTS-STARTPTS,fps=25,tpad=stop_mode=clone:stop_duration=${duration},trim=duration=${duration}[v];[1:a]apad,atrim=duration=${duration}[a]`,
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '30',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '64k',
      `part-${i}.mp4`,
    ]);
    cues.push({ start: offset, end: offset + duration, text: segment.text });
    offset += duration;
  }
  writeFileSync(join(dir, 'parts.txt'), segments.map((_, i) => `file 'part-${i}.mp4'`).join('\n'));
  writeFileSync(
    join(dir, 'captions.vtt'),
    'WEBVTT\n\n' +
      cues
        .map((c) => `${timestamp(c.start)} --> ${timestamp(c.end)}\nAI-generated voice narration: ${c.text.replace(/-->/g, '→')}\n`)
        .join('\n'),
  );
  writeFileSync(
    join(dir, 'captions.srt'),
    cues
      .map((c, i) => `${i + 1}\n${timestamp(c.start, ',')} --> ${timestamp(c.end, ',')}\nAI-generated voice narration: ${c.text}\n`)
      .join('\n'),
  );
  await ff([
    '-f',
    'concat',
    '-safe',
    '1',
    '-i',
    'parts.txt',
    '-i',
    'captions.srt',
    '-map',
    '0:v',
    '-map',
    '0:a',
    '-map',
    '1:s',
    '-c',
    'copy',
    '-c:s',
    'mov_text',
    '-metadata',
    'title=Demo with AI-generated voice narration',
    '-movflags',
    '+faststart',
    'narrated.mp4',
  ]);
  await ff(['-i', 'narrated.mp4', '-vn', '-sn', '-c:a', 'copy', 'narration.m4a']);
  return { durationSeconds: offset };
}
