// Evaluate in the app browser. All requests and preferences are isolated in a frame.
(async () => {
  const checks = [];
  const assert = (ok, message) => {
    if (!ok) throw new Error(message);
    checks.push(message);
  };
  const html = await (await fetch('/')).text();
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;left:-10000px;width:1280px;height:800px;border:0';
  const loaded = new Promise((resolve) => (frame.onload = resolve));
  const bootstrap = () => {
    const preferences = new Map();
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: (key) => preferences.get(key) ?? null,
        setItem: (key, value) => preferences.set(key, value),
        removeItem: (key) => preferences.delete(key),
      },
    });
    window.setInterval = () => 0;
    window.requests = [];
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text) => {
          window.copiedText = text;
        },
      },
    });
    const job = {
      id: 'workspace-test',
      project: 'DEMO',
      caseId: 6003,
      title: 'Multiline note',
      status: 'done',
      outcome: 'pass',
      worktree: '/test/tree',
      createdAt: '2026-01-01T00:00:00Z',
      finishedAt: '2026-01-01T00:01:00Z',
      steps: [],
    };
    window.fixtureJob = job;
    window.fixtureObservation = {
      browser: {
        status: 'active',
        stage: 'explore',
        updatedAt: new Date().toISOString(),
        frameAt: '2026-01-01T00:00:01Z',
        pageUrl: 'https://example.test/app',
      },
      network: {
        total: 2,
        errorCount: 1,
        dropped: 0,
        matching: 2,
        capturedStages: ['explore'],
        requests: [
          {
            id: 'error-1',
            stage: 'explore',
            at: '2026-01-01T00:00:01Z',
            method: 'GET',
            url: 'https://example.test/api',
            status: 503,
            durationMs: 125,
            requestId: 'request-123',
            errorBody: { message: '<img src=x onerror=alert(1)>' },
          },
          {
            id: 'success-1',
            stage: 'explore',
            at: '2026-01-01T00:00:00Z',
            method: 'GET',
            url: 'https://example.test/ok',
            status: 200,
            durationMs: 10,
          },
        ],
      },
    };
    const providers = [
      {
        id: 'codex',
        name: 'Codex',
        ready: true,
        installed: true,
        auth: 'subscription',
        models: [
          { id: 'model-a', name: 'Model A' },
          { id: 'model-b', name: 'Model B' },
        ],
      },
      {
        id: 'claude-code',
        name: 'Claude Code',
        ready: false,
        installed: true,
        auth: 'api-key',
        loginCommand: 'claude auth login',
        models: [],
      },
    ];
    window.fetch = async (path, options) => {
      if (options?.method === 'POST') {
        window.requests.push({ path, body: JSON.parse(options.body) });
        return Response.json([job.id]);
      }
      if (path.startsWith('/api/jobs/' + job.id + '/network')) {
        window.networkPath = path;
        return Response.json(window.fixtureObservation.network);
      }
      if (path.startsWith('/api/jobs/' + job.id + '/observation')) {
        const data = structuredClone(window.fixtureObservation);
        if (!path.includes('errorsOnly=0')) data.network.requests = data.network.requests.filter((r) => r.status >= 400);
        return Response.json(data);
      }
      const data =
        path === '/api/config'
          ? { roles: ['test-user'] }
          : path === '/api/cases'
            ? [
                {
                  project: 'DEMO',
                  id: 6003,
                  title: 'Multiline note',
                  steps: 3,
                  suite: 'Notes',
                },
                {
                  project: 'DEMO',
                  id: 6004,
                  title: 'Note persistence',
                  steps: 2,
                  suite: 'Notes',
                },
              ]
            : path === '/api/worktrees'
              ? [
                  {
                    path: '/test/tree',
                    branch: 'feature/verification',
                    subject: 'Test',
                  },
                ]
              : path.startsWith('/api/providers')
                ? providers
                : path === '/api/jobs'
                  ? window.hideJobFromList
                    ? []
                    : [job]
                  : path === '/api/jobs/' + job.id
                    ? { ...job, video: '/test/verification.mp4' }
                    : [];
      return Response.json(data);
    };
  };
  frame.srcdoc = html.replace('<script>', '<script>(' + bootstrap.toString() + ')();</script><script>');
  document.body.append(frame);
  const waitFor = async (predicate) => {
    for (let i = 0; i < 100; i++) {
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
    await waitFor(() => $('#model-label').textContent === 'Model A');
    assert(!$('.topbar #providers') && !$('#settings-dialog').open, 'Connection setup is outside the main workspace');
    $('[data-select="DEMO-6003"]').click();
    assert(!$('#run-selected').disabled && $('#case-summary').textContent.includes('1 case'), 'Case selection enables a run');
    $('#model-button').click();
    assert($('#model-dialog').open && d.activeElement === $('#model-search'), 'Model picker opens with search focused');
    $('[data-model="model-b"]').click();
    assert(
      $('#run-selected span').textContent === 'Run 2' && $('#model-label').textContent === '2 models',
      'Multiple models produce one run per target',
    );
    assert(d.activeElement?.dataset.model === 'model-b', 'Model selection preserves keyboard focus');
    $('#model-search').value = 'Model B';
    $('#model-search').dispatchEvent(new w.Event('input'));
    assert(d.querySelectorAll('[data-model]').length === 1, 'Model search filters the catalog');
    $('[data-picker-provider="claude-code"]').click();
    assert(
      $('.model-unavailable').textContent.includes('API key is active') && !$('#model-list [data-model]'),
      'Unavailable providers explain how to connect',
    );
    $('#picker-setup').click();
    assert($('#settings-dialog').open && !$('#model-dialog').open, 'Connection management opens separately');
    $('[data-close="settings-dialog"]').click();
    $('#run-selected').click();
    await waitFor(() => w.requests.length === 1 && $('#welcome').hidden);
    const request = w.requests[0];
    assert(
      request.path === '/api/jobs' &&
        request.body.cases.length === 1 &&
        request.body.targets.length === 2 &&
        request.body.targets.every((t) => t.authMode === 'subscription'),
      'Run submission preserves case and subscription targets',
    );
    assert($('#history-panel').hidden === false && !$('#jobs .job').hidden, 'New run opens its focused history view');
    await w.eval('beginDraft(); jobs = []; renderJobs(); selectJob("workspace-test")');
    assert(!$('#jobs .job').hidden && $('#jobs video'), 'Direct selection loads a run absent from the recent list');
    const video = $('#jobs video');
    await w.eval('refreshJobs()');
    assert(video && $('#jobs video') === video, 'Focused evidence survives polling');
    w.hideJobFromList = true;
    w.fixtureJob.outcome = 'fail';
    await w.eval('refreshJobs()');
    assert(
      $('#jobs video') === video && !$('#jobs .job').hidden && w.eval('jobs[0].outcome') === 'fail',
      'Selected older run stays fresh outside the recent list',
    );
    w.fixtureJob.outcome = 'pass';
    w.hideJobFromList = false;
    await waitFor(() => !!$('.observation .live-frame'));
    assert($('.live-label').textContent === 'Last browser frame', 'Completed runs do not claim their last frame is live');
    $('[data-observation-tab="network"]').click();
    $('.network-request-name').click();
    assert(
      d.querySelectorAll('.network-request').length === 1 && $('.network-detail-body').textContent.includes('request-123'),
      'Network errors show request IDs and diagnostic detail',
    );
    $('[data-network-detail-tab="response"]').click();
    assert(
      !$('.network-detail-body pre img') && $('.network-detail-body pre').textContent.includes('<img'),
      'Untrusted network responses render as text',
    );
    $('[data-network-filter="all"]').click();
    await waitFor(() => d.querySelectorAll('.network-request').length === 2);
    assert(d.querySelectorAll('.network-request').length === 2, 'All requests toggle includes successful requests');
    const liveFrame = $('.live-frame');
    w.fixtureJob.status = 'running';
    w.fixtureObservation.browser.frameAt = '2026-01-01T00:00:02Z';
    await w.eval('refreshJobs()');
    await w.eval('refreshObservation()');
    assert(
      $('.live-label').textContent === 'Live browser' && $('.live-frame') === liveFrame,
      'Live frames update without replacing the preview element',
    );
    assert(
      liveFrame.src.includes('00%3A00%3A02') && $('.network-request.selected')?.dataset.request === 'error-1',
      'Frame refresh preserves selected request detail',
    );
    assert($('#jobs video') === video, 'Live diagnostics updates preserve replay player identity');
    const change = (selector, value, event = 'change') => {
      $(selector).value = value;
      $(selector).dispatchEvent(new w.Event(event, { bubbles: true }));
    };
    const network = w.fixtureObservation.network;
    network.requests[0].resourceType = 'xhr';
    network.requests[1].resourceType = 'document';
    network.requests.push({
      id: 'slow-1',
      stage: 'replay-1',
      at: '2026-01-01T00:00:03Z',
      method: 'POST',
      url: 'https://example.test/slow',
      status: 200,
      durationMs: 1500,
      resourceType: 'fetch',
    });
    network.total = network.matching = 3;
    network.capturedStages.push('replay-1');
    await w.eval('refreshObservation()');
    change('[data-network-search]', 'REQUEST-123', 'input');
    assert(
      d.querySelectorAll('.network-request').length === 1 && $('.network-request').dataset.request === 'error-1',
      'Search matches request IDs without case sensitivity',
    );
    change('[data-network-search]', '', 'input');
    change('[data-network-type]', 'api');
    assert(d.querySelectorAll('.network-request').length === 2, 'Fetch/XHR filter includes both request types');
    change('[data-network-stage]', 'replay-1');
    assert(
      d.querySelectorAll('.network-request').length === 1 && $('.network-request').dataset.request === 'slow-1',
      'Stage and type filters compose',
    );
    assert($('.network-detail-body').textContent.includes('<img'), 'Filtering retains the selected response inspector');
    $('[data-network-clear]').click();
    await w.eval('refreshObservation()');
    $('[data-network-filter="slow"]').click();
    assert(
      d.querySelectorAll('.network-request').length === 1 && $('.network-request').dataset.request === 'slow-1',
      'Slow filter applies the one-second threshold',
    );
    $('[data-network-filter="all"]').click();
    change('[data-network-sort]', 'slowest');
    assert($('.network-request').dataset.request === 'slow-1', 'Slowest sort puts the longest duration first');
    change('[data-network-sort]', 'oldest');
    assert($('.network-request').dataset.request === 'success-1', 'Oldest sort follows request timestamps');
    change('[data-network-sort]', 'newest');
    $('.network-request-name').click();
    $('[data-network-detail-tab="response"]').click();
    assert(
      $('.network-detail-body').textContent.includes('No response body captured'),
      'Missing response bodies have an explicit explanation',
    );
    $('[data-network-detail-tab="raw"]').click();
    assert(JSON.parse($('.network-detail-body pre').textContent).id === 'slow-1', 'Raw tab contains the selected diagnostic record');
    $('[data-network-copy="url"]').click();
    await waitFor(() => w.copiedText === 'https://example.test/slow');
    assert(w.copiedText === 'https://example.test/slow', 'Copy URL writes only the selected URL');
    $('[data-network-copy="details"]').click();
    await waitFor(() => w.copiedText.startsWith('{'));
    assert(JSON.parse(w.copiedText).id === 'slow-1', 'Copy details writes the selected sanitized record');
    $('.network-request-name').focus();
    $('.network-request-name').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert(
      $('.network-request.selected').dataset.request === 'error-1' &&
        d.activeElement.closest('[data-request]').dataset.request === 'error-1',
      'Arrow navigation selects and focuses the next request',
    );
    d.activeElement.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert(
      $('.network-detail').hidden && d.activeElement.closest('[data-request]').dataset.request === 'error-1',
      'Escape closes request details and retains list focus',
    );
    $('[data-network-pause]').click();
    network.requests.push({
      id: 'new-1',
      stage: 'replay-1',
      at: '2026-01-01T00:00:04Z',
      method: 'GET',
      url: 'https://example.test/new',
      status: 201,
      durationMs: 20,
      resourceType: 'fetch',
    });
    network.total = network.matching = 4;
    await w.eval('refreshObservation()');
    assert(
      d.querySelectorAll('.network-request').length === 3 && $('.network-count').textContent.includes('Feed paused'),
      'Pause feed freezes displayed requests while capture updates',
    );
    $('[data-network-pause]').click();
    await waitFor(() => d.querySelectorAll('.network-request').length === 4);
    assert(d.querySelectorAll('.network-request').length === 4, 'Resume feed displays newly captured requests');
    network.matching = 250;
    network.dropped = 10;
    await w.eval('refreshObservation()');
    assert(
      !$('[data-network-more]').hidden &&
        $('.network-note').textContent.includes('10 requests were omitted') &&
        $('.network-note').textContent.includes('Filters apply to loaded requests'),
      'Partial captures disclose filtering and retention boundaries',
    );
    $('[data-network-more]').click();
    await waitFor(() => w.networkPath?.includes('limit=200'));
    assert(w.networkPath.includes('errorsOnly=0'), 'Load more requests a larger bounded capture');
    await waitFor(() => !$('[data-network-more]').disabled);
    $('.network-request-name').click();
    frame.style.width = '390px';
    frame.style.height = '844px';
    await new Promise((resolve) => setTimeout(resolve, 30));
    const tableRect = $('.network-table-scroll').getBoundingClientRect();
    const detailRect = $('.network-detail').getBoundingClientRect();
    assert(
      d.documentElement.scrollWidth <= w.innerWidth && detailRect.top >= tableRect.bottom && detailRect.width <= w.innerWidth,
      'Mobile network inspector stacks below the request list without overflow',
    );
    $('#theme-toggle').click();
    assert(
      w.getComputedStyle($('.network-table th')).backgroundColor !== 'rgba(0, 0, 0, 0)',
      'Light theme keeps an opaque sticky table header',
    );
    $('#theme-toggle').click();
    frame.style.width = '1280px';
    frame.style.height = '800px';
    w.fixtureObservation.browser.status = 'closed';
    await w.eval('refreshObservation()');
    assert($('.live-label').textContent === 'Last browser frame', 'Closed sessions stop displaying the live indicator');
    $('#new-run').click();
    assert(
      !$('#welcome').hidden && $('#clear-selection').hidden && !$('#case-panel').hidden,
      'New verification clears the draft and returns to cases',
    );
    $('#theme-toggle').click();
    assert(d.documentElement.dataset.theme === 'light' && w.localStorage.getItem('theme') === 'light', 'Color theme is persisted');
    frame.style.width = '390px';
    frame.style.height = '844px';
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert(
      w.getComputedStyle($('.sidebar')).display === 'none' && d.documentElement.scrollWidth <= w.innerWidth,
      'Mobile workspace fits without horizontal overflow',
    );
    $('#sidebar-toggle').click();
    assert(w.getComputedStyle($('.sidebar')).display === 'flex', 'Mobile sidebar opens');
    $('#sidebar-scrim').click();
    $('#model-button').click();
    const rect = $('#model-dialog').getBoundingClientRect();
    assert(
      rect.left >= 0 && rect.right <= w.innerWidth && rect.top >= 0 && rect.bottom <= w.innerHeight,
      'Mobile model picker stays inside the viewport',
    );
    return { passed: checks.length, checks };
  } catch (error) {
    return { failed: error.message, passed: checks.length, checks };
  } finally {
    frame.remove();
  }
})();
