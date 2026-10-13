// Exercise the built React app through HTTP fixtures and real user interactions.
(async () => {
  const checks = [];
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
    checks.push(message);
  };
  const html = await (await fetch('/')).text();
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;left:-10000px;width:1280px;height:800px;border:0';
  const loaded = new Promise((resolve) => {
    frame.onload = resolve;
  });
  const bootstrap = () => {
    Object.defineProperty(document, 'hidden', { value: false });
    const preferences = new Map([['active-job', JSON.stringify('playback-regression')]]);
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: (key) => preferences.get(key) ?? null,
        setItem: (key, value) => preferences.set(key, value),
        removeItem: (key) => preferences.delete(key),
      },
    });
    const timers = new Map();
    window.fixtureTimers = timers;
    let id = 0;
    window.setInterval = (fn, ms) => {
      timers.set(++id, { fn, ms });
      return id;
    };
    window.clearInterval = (id) => timers.delete(id);
    window.tick = async (ms) => {
      for (const timer of [...timers.values()]) if (timer.ms === ms) await timer.fn();
      await new Promise((resolve) => setTimeout(resolve, 40));
    };
    const finished = {
      id: 'playback-regression',
      project: 'DEMO',
      caseId: 6003,
      title: 'Playback regression',
      worktree: '/test/worktree',
      status: 'done',
      outcome: 'pass',
      createdAt: '2026-01-01T00:00:00Z',
      finishedAt: '2026-01-01T00:01:00Z',
      steps: [],
    };
    window.fixtureJobs = [
      finished,
      { ...finished, id: 'playback-running', status: 'running', stage: 'explore', finishedAt: undefined, log: ['Exploring'] },
      { ...finished, id: 'playback-other', caseId: 6004 },
    ];
    window.fixtureDetails = {};
    window.fetch = async (path) => {
      if (path === '/api/jobs') return Response.json(window.fixtureJobs);
      if (/^\/api\/jobs\/playback-[^/]+$/.test(path)) {
        const id = path.split('/').pop();
        return Response.json({
          ...window.fixtureJobs.find((j) => j.id === id),
          video: '/test/verification.mp4',
          ...window.fixtureDetails[id],
        });
      }
      if (path.includes('/observation'))
        return Response.json({
          browser: null,
          network: { total: 0, errorCount: 0, dropped: 0, matching: 0, requests: [], capturedStages: [] },
        });
      return Response.json(path === '/api/config' ? { roles: [], environments: [] } : []);
    };
  };
  frame.srcdoc = html.replace('</head>', '<script>(' + bootstrap.toString() + ')();</script></head>');
  document.body.append(frame);
  const waitFor = async (predicate) => {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('UI did not settle');
  };
  try {
    await loaded;
    const w = frame.contentWindow,
      d = w.document,
      $ = (selector) => d.querySelector(selector);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
    await waitFor(() => $('[data-job="playback-regression"] video'));
    const video = $('[data-job="playback-regression"] video');
    video.volume = 0.3;
    video.playbackRate = 1.5;
    await w.tick(2000);
    assert($('[data-job="playback-regression"] video') === video && video.isConnected, 'Polling keeps the video mounted');
    w.fixtureJobs[1].stage = 'codify';
    w.fixtureJobs[1].log = ['Codifying'];
    await w.tick(2000);
    assert($('[data-job="playback-running"] .log').textContent === 'Codifying', 'Running jobs still update');
    assert($('[data-job="playback-regression"] video') === video, 'Progress updates keep the finished video mounted');
    $('[data-open-job="playback-other"]').click();
    await settle();
    assert($('[data-job="playback-regression"] video') === video, 'Opening another run keeps the video mounted');
    $('[data-open-job="playback-regression"]').click();
    await settle();
    w.fixtureJobs[0].title = 'Updated title';
    await w.tick(2000);
    assert($('[data-job="playback-regression"] .title').textContent === 'Updated title', 'Run metadata still updates');
    assert($('[data-job="playback-regression"] video') === video, 'Metadata updates keep the video mounted');
    w.fixtureDetails['playback-regression'] = { notes: 'Updated evidence' };
    await w.tick(2000);
    assert($('[data-job="playback-regression"] .notes').textContent === 'Updated evidence', 'Evidence still updates');
    assert(
      $('[data-job="playback-regression"] video') === video && video.volume === 0.3 && video.playbackRate === 1.5,
      'Evidence updates preserve the player and its settings',
    );
    w.fixtureJobs.unshift({ ...w.fixtureJobs[2], id: 'playback-new' });
    await w.tick(2000);
    assert($('#jobs').firstElementChild.dataset.job === 'playback-new', 'New runs appear first');
    assert($('[data-job="playback-regression"] video') === video && video.isConnected, 'New runs keep the video mounted');
    $('[data-toggle="playback-regression"]').click();
    await settle();
    assert(!$('[data-job="playback-regression"] video'), 'Collapsing a run removes its player');
    $('#new-run').click();
    await settle();
    w.fixtureJobs = [];
    await w.tick(2000);
    assert(!$('#jobs .job') && $('#running-count').textContent === '', 'Removed runs and counts are cleared');
    return { passed: checks.length, checks };
  } catch (error) {
    return { failed: error.message, passed: checks.length, checks };
  } finally {
    frame.remove();
  }
})();
