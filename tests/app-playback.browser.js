// Evaluate this file in the local app's browser context. The fixture frame disables
// timers and mocks APIs so it never starts jobs or depends on existing run data.
(async () => {
const checkPlayback = async function () {
  const originalFetch = window.fetch;
  const originalJobs = jobs;
  const originalExpanded = new Set(expanded);
  const originalDetails = new Map(details);
  const checks = [];
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
    checks.push(message);
  };
  const finished = {
    id: 'playback-regression', project: 'DEMO', caseId: 6003,
    title: 'Playback regression', worktree: '/test/worktree',
    status: 'done', outcome: 'pass', createdAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:01:00Z', steps: [],
  };
  const other = { ...finished, id: 'playback-other', caseId: 6004 };
  const running = { ...finished, id: 'playback-running', status: 'running', stage: 'explore', finishedAt: undefined, log: ['Exploring'] };
  let responses = [finished, running, other];
  window.fetch = async (input, options) => {
    const path = String(input);
    if (path === '/api/jobs') return Response.json(responses);
    if (path.startsWith('/api/jobs/playback-')) return Response.json({ ...responses.find(j => path.endsWith(j.id)), video: '/test/verification.mp4' });
    return originalFetch(input, options);
  };
  try {
    expanded.clear();
    details.clear();
    jobs = responses;
    expanded.add(finished.id);
    details.set(finished.id, { ...finished, video: '/test/verification.mp4', final: true });
    renderJobs();
    const video = document.querySelector('[data-job="playback-regression"] video');
    video.volume = 0.3;
    video.playbackRate = 1.5;

    await refreshJobs();
    assert(document.querySelector('[data-job="playback-regression"] video') === video && video.isConnected, 'Polling keeps the video mounted');

    responses = [finished, { ...running, stage: 'codify', log: ['Codifying'] }, other];
    await refreshJobs();
    assert(document.querySelector('[data-job="playback-running"] .log').textContent === 'Codifying', 'Running jobs still update');
    assert(document.querySelector('[data-job="playback-regression"] video') === video, 'Progress updates keep the finished video mounted');

    expanded.add(other.id);
    details.set(other.id, { ...other, final: true });
    renderJobs();
    assert(document.querySelector('[data-job="playback-regression"] video') === video, 'Opening another run keeps the video mounted');

    responses = [{ ...finished, title: 'Updated title' }, running, other];
    await refreshJobs();
    assert(document.querySelector('[data-job="playback-regression"] .title').textContent === 'Updated title', 'Run metadata still updates');
    assert(document.querySelector('[data-job="playback-regression"] video') === video, 'Metadata updates keep the video mounted');

    details.set(finished.id, { ...details.get(finished.id), notes: 'Updated evidence' });
    renderJobs();
    assert(document.querySelector('[data-job="playback-regression"] .notes').textContent === 'Updated evidence', 'Evidence still updates');
    assert(document.querySelector('[data-job="playback-regression"] video') === video && video.volume === 0.3 && video.playbackRate === 1.5, 'Evidence updates preserve the player and its settings');

    responses = [{ ...other, id: 'playback-new' }, ...responses];
    await refreshJobs();
    assert(document.querySelector('#jobs').firstElementChild.dataset.job === 'playback-new', 'New runs appear first');
    assert(document.querySelector('[data-job="playback-regression"] video') === video && video.isConnected, 'New runs keep the video mounted');

    expanded.delete(finished.id);
    renderJobs();
    assert(!document.querySelector('[data-job="playback-regression"] video'), 'Collapsing a run removes its player');
    responses = [];
    await refreshJobs();
    assert(!document.querySelector('#jobs .job') && document.querySelector('#running-count').textContent === '', 'Removed runs and counts are cleared');
    return { passed: checks.length, checks };
  } catch (error) {
    return { failed: error.message, passed: checks.length, checks };
  } finally {
    window.fetch = originalFetch;
    jobs = originalJobs;
    expanded.clear();
    originalExpanded.forEach(id => expanded.add(id));
    details.clear();
    originalDetails.forEach((value, id) => details.set(id, value));
    renderJobs();
  }
};
const html = await (await fetch('/')).text();
const frame = document.createElement('iframe');
frame.hidden = true;
const loaded = new Promise(resolve => { frame.onload = resolve; });
frame.srcdoc = html.replace('<script>', `<script>
  Object.defineProperty(window, 'localStorage', { value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
  window.setInterval = () => 0;
  window.fetch = async (path) => Response.json(path === '/api/config' ? { roles: [] } : []);
</script><script>`);
document.body.append(frame);
try {
  await loaded;
  return await frame.contentWindow.eval('(' + checkPlayback.toString() + ')()');
} finally {
  frame.remove();
}
})()
