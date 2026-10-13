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
    Object.defineProperty(document, 'hidden', { value: false });
    const preferences = new Map([['active-job', JSON.stringify('workspace-test')]]);
    window.hideJobFromList = true;
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: (key) => preferences.get(key) ?? null,
        setItem: (key, value) => preferences.set(key, value),
        removeItem: (key) => preferences.delete(key),
      },
    });
    const timers = new Map();
    window.fixtureTimers = timers;
    let nextTimer = 0;
    window.setInterval = (fn, ms) => {
      timers.set(++nextTimer, { fn, ms });
      return nextTimer;
    };
    window.clearInterval = (id) => timers.delete(id);
    window.tick = async (ms) => {
      for (const timer of [...timers.values()]) if (timer.ms === ms) await timer.fn();
      await new Promise((resolve) => setTimeout(resolve, 40));
    };
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
      usage: {
        status: 'complete',
        totalTokens: 1500,
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 800,
        cacheWriteTokens: 0,
        estimatedApiCostUsd: 0.0123,
        providerReportedCostUsd: null,
      },
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
    window.fixtureCases = [
      { project: 'DEMO', id: 6003, title: 'Multiline note', steps: 3, suite: 'Notes' },
      { project: 'DEMO', id: 6004, title: 'Note persistence', steps: 2, suite: 'Notes' },
    ];
    window.fixtureEnvironments = [
      {
        id: 'local',
        name: 'Local development',
        kind: 'worktree',
        devMode: 'ci.development',
        revision: 'local-1',
        users: [{ id: 'test-user', name: 'Local tester', usernameRef: 'env://LOCAL_USERNAME', passwordRef: 'env://LOCAL_PASSWORD' }],
      },
    ];
    window.fetch = async (path, options) => {
      if (path === '/api/environments' && options?.method === 'POST') {
        const body = JSON.parse(options.body);
        const saved = { ...body.environment, revision: 'updated' };
        window.fixtureEnvironments = [...window.fixtureEnvironments.filter((e) => e.id !== saved.id), saved];
        return Response.json(saved);
      }
      if (path === '/api/environments/staging/delete' && options?.method === 'POST') {
        window.fixtureEnvironments = window.fixtureEnvironments.filter((e) => e.id !== 'staging');
        return Response.json({ id: 'staging', deleted: true });
      }
      if (path.startsWith('/api/environments')) return Response.json(window.fixtureEnvironments);
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
          ? { roles: ['test-user'], environments: window.fixtureEnvironments }
          : path === '/api/cases'
            ? window.fixtureCases
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
  frame.srcdoc = html.replace('</head>', '<script>(' + bootstrap.toString() + ')();</script></head>');
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
    const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
    const setInput = (input, value) => {
      const proto = input.tagName === 'SELECT' ? w.HTMLSelectElement.prototype : w.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value);
    };
    await waitFor(() => $('#model-label')?.textContent === 'Model A' && [...w.fixtureTimers.values()].some((t) => t.ms === 5000));
    assert(!$('#jobs .job').hidden && $('#jobs video'), 'Direct selection loads a run absent from the recent list');
    w.hideJobFromList = false;
    $('#new-run').click();
    await settle();
    await w.tick(2000);
    assert(!$('.topbar #providers') && !$('#settings-dialog')?.open, 'Connection setup is outside the main workspace');
    w.fixtureCases.push({ project: 'LOCAL', id: 1, title: 'New draft', steps: 0, suite: 'Native', status: 'draft' });
    await w.tick(5000);
    assert(
      $('[data-select="LOCAL-1"]').disabled && $('[data-run="LOCAL-1"]').disabled,
      'MCP-created drafts appear with disabled run controls',
    );
    w.fixtureCases[2].status = 'active';
    w.fixtureCases[2].steps = 1;
    await w.tick(5000);
    assert(!$('[data-select="LOCAL-1"]').disabled, 'Activated cases become runnable after catalog refresh');
    $('[data-select="LOCAL-1"]').click();
    await settle();
    w.fixtureCases.pop();
    await w.tick(5000);
    assert(!$('[data-select="LOCAL-1"]') && $('#clear-selection').hidden, 'Archived cases disappear and leave the pending selection');
    $('[data-select="DEMO-6003"]').click();
    await settle();
    assert(!$('#run-selected').disabled && $('#case-summary').textContent.includes('1 case'), 'Case selection enables a run');
    $('#model-button').click();
    await settle();
    assert($('#model-dialog').open && d.activeElement === $('#model-search'), 'Model picker opens with search focused');
    $('[data-model="model-b"]').focus();
    $('[data-model="model-b"]').click();
    await settle();
    assert(
      $('#run-selected span').textContent === 'Run 2' && $('#model-label').textContent === '2 models',
      'Multiple models produce one run per target',
    );
    assert(d.activeElement?.dataset.model === 'model-b', 'Model selection preserves keyboard focus');
    setInput($('#model-search'), 'Model B');
    $('#model-search').dispatchEvent(new w.Event('input', { bubbles: true }));
    await settle();
    assert(d.querySelectorAll('[data-model]').length === 1, 'Model search filters the catalog');
    $('[data-picker-provider="claude-code"]').click();
    await settle();
    assert(
      $('.model-unavailable').textContent.includes('API key is active') && !$('#model-list [data-model]'),
      'Unavailable providers explain how to connect',
    );
    $('#picker-setup').click();
    await settle();
    assert($('#settings-dialog').open && !$('#model-dialog').open, 'Connection management opens separately');
    $('[data-settings-tab="environments"]').click();
    await settle();
    await waitFor(() => !!$('[data-edit-environment="local"]'));
    assert(
      $('#environment-id').readOnly && $('[data-user-field="passwordRef"]').value === 'env://LOCAL_PASSWORD',
      'Settings shows editable credential references without resolving secret values',
    );
    $('#new-environment').click();
    await settle();
    $('#environment-id').value = 'staging';
    $('#environment-name').value = 'Staging';
    $('#environment-url').value = 'https://staging.example.test';
    const setUser = (row, id) => {
      for (const [field, value] of Object.entries({
        id,
        name: id,
        usernameRef: 'env://STAGING_USERNAME',
        passwordRef: 'env://STAGING_PASSWORD',
      }))
        row.querySelector(`[data-user-field="${field}"]`).value = value;
    };
    setUser($('.test-user-card'), 'admin');
    $('#add-test-user').click();
    await settle();
    setUser(d.querySelectorAll('.test-user-card')[1], 'viewer');
    $('#environment-form').requestSubmit();
    await waitFor(() => $('#environment-message').textContent.includes('saved'));
    assert(
      w.fixtureEnvironments.find((e) => e.id === 'staging').users.length === 2,
      'Settings saves a hosted environment with multiple test users',
    );
    $('#environment').value = 'staging';
    $('#environment').dispatchEvent(new w.Event('change', { bubbles: true }));
    await settle();
    assert(
      $('.worktree-control').hidden && $('#role').options.length === 2 && $('#role').value === 'admin',
      'Hosted selection uses only that environment’s users and hides worktree selection',
    );
    const savedWorktree = $('#worktree').value;
    $('#worktree').value = '';
    $('#worktree').dispatchEvent(new w.Event('change', { bubbles: true }));
    await settle();
    await settle();
    assert(!$('#run-selected').disabled, 'Hosted verification does not require a local worktree');
    $('#role').value = 'viewer';
    $('#role').dispatchEvent(new w.Event('change', { bubbles: true }));
    await settle();
    $('#environment').value = 'local';
    $('#environment').dispatchEvent(new w.Event('change', { bubbles: true }));
    await settle();
    assert(
      $('#role').value === 'test-user' && !$('.worktree-control').hidden,
      'Changing environments resets the test user to a valid member',
    );
    $('#environment').value = 'staging';
    $('#environment').dispatchEvent(new w.Event('change', { bubbles: true }));
    await settle();
    assert($('#role').value === 'viewer', 'Each environment remembers its own test-user selection');
    frame.style.width = '390px';
    await new Promise((resolve) => setTimeout(resolve, 30));
    const settingsRect = $('#settings-dialog').getBoundingClientRect();
    assert(
      settingsRect.left >= 0 &&
        settingsRect.right <= w.innerWidth &&
        $('#settings-dialog').scrollWidth <= $('#settings-dialog').clientWidth,
      'Environment settings fit the mobile viewport',
    );
    frame.style.width = '1280px';
    $('#delete-environment').click();
    await settle();
    await waitFor(() => !w.fixtureEnvironments.some((e) => e.id === 'staging') && $('#environment').value === 'local');
    assert($('#role').value === 'test-user', 'Deleting a selected environment falls back to the local profile');
    $('#worktree').value = savedWorktree;
    $('#worktree').dispatchEvent(new w.Event('change', { bubbles: true }));
    await settle();
    await settle();
    $('[data-close="settings-dialog"]').click();
    await settle();
    $('#run-selected').click();
    await settle();
    await waitFor(() => w.requests.length === 1 && $('#welcome').hidden);
    const request = w.requests[0];
    assert(
      request.path === '/api/jobs' &&
        request.body.cases.length === 1 &&
        request.body.targets.length === 2 &&
        request.body.targets.every((t) => t.authMode === 'subscription') &&
        request.body.environmentId === 'local' &&
        request.body.userId === 'test-user',
      'Run submission preserves case and subscription targets',
    );
    assert($('#history-panel').hidden === false && !$('#jobs .job').hidden, 'New run opens its focused history view');

    assert(
      $('#jobs .run-metrics').textContent.includes('API-equivalent cost') && $('#jobs .run-metrics').textContent.includes('$0.0123'),
      'Provider token counts display a library-priced API estimate',
    );
    assert(
      $('#jobs .run-metrics').textContent.includes('not a bill') && $('#jobs .metrics').textContent.includes('cache write 0'),
      'Estimated cost is distinct from billing and cache categories are visible',
    );
    w.fixtureJob.usage.estimatedApiCostUsd = null;
    await w.tick(2000);
    assert($('#jobs .run-metrics').textContent.includes('Unavailable'), 'Missing model pricing stays unavailable');
    w.fixtureJob.usage.providerReportedCostUsd = 0.0456;
    await w.tick(2000);
    assert(
      $('#jobs .run-metrics').textContent.includes('Reported cost') && $('#jobs .run-metrics').textContent.includes('$0.0456'),
      'Provider-reported cost remains available when catalog pricing is missing',
    );
    w.fixtureJob.usage.estimatedApiCostUsd = 0.0123;
    w.fixtureJob.usage.providerReportedCostUsd = null;
    await w.tick(2000);
    const video = $('#jobs video');
    await w.tick(2000);
    assert(video && $('#jobs video') === video, 'Focused evidence survives polling');
    w.hideJobFromList = true;
    w.fixtureJob.outcome = 'fail';
    await w.tick(2000);
    assert(
      $('#jobs video') === video && !$('#jobs .job').hidden && $('#jobs .chip').textContent === 'Failed',
      'Selected older run stays fresh outside the recent list',
    );
    w.fixtureJob.outcome = 'pass';
    w.hideJobFromList = false;
    await waitFor(() => !!$('.observation .live-frame'));
    assert($('.live-label').textContent === 'Last browser frame', 'Completed runs do not claim their last frame is live');
    $('[data-network-toggle]').click();
    await settle();
    const preview = $('.live-frame');
    assert(
      !$('.browser-pane').hidden && !$('.network-pane').hidden && $('[data-network-toggle]').getAttribute('aria-expanded') === 'true',
      'Network opens alongside the browser without hiding it',
    );
    const browserRect = $('.browser-pane').getBoundingClientRect();
    const panelRect = $('.network-pane').getBoundingClientRect();
    assert(panelRect.left >= browserRect.right && panelRect.right <= w.innerWidth, 'Desktop network panel docks beside the browser');
    $('[data-network-dismiss]').click();
    await settle();
    assert(
      $('.network-pane').hidden && $('.live-frame') === preview && d.activeElement === $('[data-network-toggle]'),
      'Closing the side panel preserves the browser and restores focus',
    );
    $('[data-network-toggle]').click();
    await settle();
    $('.network-request-name').click();
    await settle();
    assert(
      d.querySelectorAll('.network-request').length === 1 && $('.network-detail-body').textContent.includes('request-123'),
      'Network errors show request IDs and diagnostic detail',
    );
    $('[data-network-detail-tab="response"]').click();
    await settle();
    assert(
      !$('.network-detail-body pre img') && $('.network-detail-body pre').textContent.includes('<img'),
      'Untrusted network responses render as text',
    );
    $('[data-network-filter="all"]').click();
    await settle();
    await waitFor(() => d.querySelectorAll('.network-request').length === 2);
    assert(d.querySelectorAll('.network-request').length === 2, 'All requests toggle includes successful requests');
    const liveFrame = $('.live-frame');
    w.fixtureJob.status = 'running';
    w.fixtureObservation.browser.frameAt = '2026-01-01T00:00:02Z';
    await w.tick(2000);
    await w.tick(1000);
    assert(
      $('.live-label').textContent === 'Live browser' && $('.live-frame') === liveFrame,
      'Live frames update without replacing the preview element',
    );
    assert(
      liveFrame.src.includes('00%3A00%3A02') && $('.network-request.selected')?.dataset.request === 'error-1',
      'Frame refresh preserves selected request detail',
    );
    assert($('#jobs video') === video, 'Live diagnostics updates preserve replay player identity');
    const change = async (selector, value, event = 'change') => {
      setInput($(selector), value);
      $(selector).dispatchEvent(new w.Event(event, { bubbles: true }));
      await settle();
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
    await w.tick(1000);
    await change('[data-network-search]', 'REQUEST-123', 'input');
    assert(
      d.querySelectorAll('.network-request').length === 1 && $('.network-request').dataset.request === 'error-1',
      'Search matches request IDs without case sensitivity',
    );
    await change('[data-network-search]', '', 'input');
    await change('[data-network-type]', 'api');
    assert(d.querySelectorAll('.network-request').length === 2, 'Fetch/XHR filter includes both request types');
    await change('[data-network-stage]', 'replay-1');
    assert(
      d.querySelectorAll('.network-request').length === 1 && $('.network-request').dataset.request === 'slow-1',
      'Stage and type filters compose',
    );
    assert($('.network-detail-body').textContent.includes('<img'), 'Filtering retains the selected response inspector');
    $('[data-network-clear]').click();
    await settle();
    await w.tick(1000);
    $('[data-network-filter="slow"]').click();
    await settle();
    assert(
      d.querySelectorAll('.network-request').length === 1 && $('.network-request').dataset.request === 'slow-1',
      'Slow filter applies the one-second threshold',
    );
    $('[data-network-filter="all"]').click();
    await settle();
    await change('[data-network-sort]', 'slowest');
    assert($('.network-request').dataset.request === 'slow-1', 'Slowest sort puts the longest duration first');
    await change('[data-network-sort]', 'oldest');
    assert($('.network-request').dataset.request === 'success-1', 'Oldest sort follows request timestamps');
    await change('[data-network-sort]', 'newest');
    $('.network-request-name').click();
    await settle();
    $('[data-network-detail-tab="response"]').click();
    await settle();
    assert(
      $('.network-detail-body').textContent.includes('No response body captured'),
      'Missing response bodies have an explicit explanation',
    );
    $('[data-network-detail-tab="raw"]').click();
    await settle();
    assert(JSON.parse($('.network-detail-body pre').textContent).id === 'slow-1', 'Raw tab contains the selected diagnostic record');
    $('[data-network-copy="url"]').click();
    await settle();
    await waitFor(() => w.copiedText === 'https://example.test/slow');
    assert(w.copiedText === 'https://example.test/slow', 'Copy URL writes only the selected URL');
    $('[data-network-copy="details"]').click();
    await settle();
    await waitFor(() => w.copiedText.startsWith('{'));
    assert(JSON.parse(w.copiedText).id === 'slow-1', 'Copy details writes the selected sanitized record');
    $('.network-request-name').focus();
    $('.network-request-name').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await settle();
    assert(
      $('.network-request.selected').dataset.request === 'error-1' &&
        d.activeElement.closest('[data-request]').dataset.request === 'error-1',
      'Arrow navigation selects and focuses the next request',
    );
    d.activeElement.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    assert(
      $('.network-detail').hidden && d.activeElement.closest('[data-request]').dataset.request === 'error-1',
      'Escape closes request details and retains list focus',
    );
    $('[data-network-pause]').click();
    await settle();
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
    await w.tick(1000);
    assert(
      d.querySelectorAll('.network-request').length === 3 && $('.network-count').textContent.includes('Feed paused'),
      'Pause feed freezes displayed requests while capture updates',
    );
    $('[data-network-pause]').click();
    await settle();
    await waitFor(() => d.querySelectorAll('.network-request').length === 4);
    assert(d.querySelectorAll('.network-request').length === 4, 'Resume feed displays newly captured requests');
    network.matching = 250;
    network.dropped = 10;
    await w.tick(1000);
    assert(
      !$('[data-network-more]').hidden &&
        $('.network-note').textContent.includes('10 requests were omitted') &&
        $('.network-note').textContent.includes('Filters apply to loaded requests'),
      'Partial captures disclose filtering and retention boundaries',
    );
    $('[data-network-more]').click();
    await settle();
    await waitFor(() => w.networkPath?.includes('limit=200'));
    assert(w.networkPath.includes('errorsOnly=0'), 'Load more requests a larger bounded capture');
    await waitFor(() => !$('[data-network-more]').disabled);
    $('.network-request-name').click();
    await settle();
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
    await settle();
    assert(
      w.getComputedStyle($('.network-table th')).backgroundColor !== 'rgba(0, 0, 0, 0)',
      'Light theme keeps an opaque sticky table header',
    );
    $('#theme-toggle').click();
    await settle();
    frame.style.width = '1280px';
    frame.style.height = '800px';
    w.fixtureObservation.browser.status = 'closed';
    await w.tick(1000);
    assert($('.live-label').textContent === 'Last browser frame', 'Closed sessions stop displaying the live indicator');
    $('#new-run').click();
    await settle();
    assert(
      !$('#welcome').hidden && $('#clear-selection').hidden && !$('#case-panel').hidden,
      'New verification clears the draft and returns to cases',
    );
    $('#theme-toggle').click();
    await settle();
    assert(d.documentElement.dataset.theme === 'light' && w.localStorage.getItem('theme') === 'light', 'Color theme is persisted');
    frame.style.width = '390px';
    frame.style.height = '844px';
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert(
      w.getComputedStyle($('.sidebar')).display === 'none' && d.documentElement.scrollWidth <= w.innerWidth,
      'Mobile workspace fits without horizontal overflow',
    );
    $('#sidebar-toggle').click();
    await settle();
    assert(w.getComputedStyle($('.sidebar')).display === 'flex', 'Mobile sidebar opens');
    $('#sidebar-scrim').click();
    await settle();
    $('#model-button').click();
    await settle();
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
