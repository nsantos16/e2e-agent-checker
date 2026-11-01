export type RecordedStep = {
  position: number;
  title: string;
  startedAt: number;
  endedAt?: number;
  status: 'passed' | 'failed' | 'incomplete';
};
export type ReplayTimeline = {
  version: 1;
  clock: 'wall';
  closedAt?: number;
  steps: RecordedStep[];
};
export type TimedStep = RecordedStep & {
  startSeconds: number;
  endSeconds: number;
};
// Video is finalized at page close. Preserve the original recording; align wall-clock captions
// to its end rather than inventing timings from exploration or evenly dividing the movie.
export function alignTimeline(timeline: ReplayTimeline, duration: number): TimedStep[] {
  if (!timeline.closedAt || !Number.isFinite(duration) || duration <= 0)
    throw new Error('Recording timing is unavailable; replay the saved spec to capture it');
  const origin = timeline.closedAt - duration * 1000;
  return timeline.steps
    .map((step) => ({
      ...step,
      startSeconds: Math.max(0, (step.startedAt - origin) / 1000),
      endSeconds: Math.min(duration, ((step.endedAt ?? timeline.closedAt!) - origin) / 1000),
    }))
    .filter((s) => s.endSeconds > s.startSeconds && s.startSeconds < duration);
}
