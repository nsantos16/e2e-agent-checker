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
  const bootstrap = (saved) => {
    Object.defineProperty(document, 'hidden', { value: false });
    const preferences = new Map(saved?.preferences ?? [['active-job', JSON.stringify('workspace-test')]]);
    window.fixturePreferences = preferences;
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
      ...saved?.job,
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
    window.fixtureCases = saved?.cases ?? [
      { project: 'DEMO', id: 6003, revision: 'case-6003', title: 'Multiline note', steps: 3, suite: 'Notes' },
      { project: 'DEMO', id: 6004, revision: 'case-6004', title: 'Note persistence', steps: 2, suite: 'Notes' },
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
    window.fixtureWorktrees = [{ path: '/test/tree', branch: 'feature/verification', subject: 'Test' }];
    window.fetch = async (path, options) => {
      if (path === '/api/settings/voice')
        return Response.json({
          settings: {
            enabled: false,
            textModel: 'gpt-6-luna',
            speechModel: 'gpt-realtime-2.1-mini',
            voice: 'marin',
            speechCredentialRef: null,
            revision: 'fixture',
          },
          speech: { status: 'not-configured', verified: false },
        });
      if (/^\/api\/jobs\/[^/]+\/demos$/.test(path)) return Response.json({ demos: [], silentVideo: null });
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
        if (/^\/api\/cases\/[^/]+\/\d+\/delete$/.test(path)) {
          if (window.rejectRemoval) return Response.json({ error: 'Case changed. Refresh before removing.' }, { status: 409 });
          const [, , , project, id] = path.split('/');
          window.fixtureCases = window.fixtureCases.filter((c) => c.project !== project || c.id !== Number(id));
          return Response.json({ status: 'archived' });
        }
        if (path === '/api/jobs/' + job.id + '/remove') {
          if (window.rejectRemoval) return Response.json({ error: 'Removal failed. Try again.' }, { status: 500 });
          job.hiddenAt = new Date().toISOString();
          return Response.json({ id: job.id, hiddenAt: job.hiddenAt });
        }
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
              ? window.fixtureWorktrees
              : path.startsWith('/api/providers')
                ? providers
                : path === '/api/jobs'
                  ? window.hideJobFromList || job.hiddenAt
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
    const openPicker = async (selector) => {
      const trigger = $(selector);
      trigger.focus();
      trigger.click();
      await settle();
      const menu = d.getElementById(trigger.getAttribute('aria-controls'));
      if (!menu?.open) throw new Error(`Picker did not open: ${selector}`);
      return menu;
    };
    const chooseOption = async (selector, value) => {
      const menu = await openPicker(selector);
      const option = [...menu.querySelectorAll('[role="option"]')].find((option) => option.dataset.value === value);
      if (!option || option.disabled) throw new Error(`Option unavailable: ${selector} ${value}`);
      option.click();
      await settle();
      assert(!menu.isConnected && d.activeElement === $(selector), `${selector} applies a choice and returns focus to its trigger`);
    };
    await waitFor(() => $('#model-label')?.textContent === 'Model A' && [...w.fixtureTimers.values()].some((t) => t.ms === 5000));
    assert(!$('#jobs .job').hidden && $('#jobs video'), 'Direct selection loads a run absent from the recent list');
    w.hideJobFromList = false;
    $('#new-run').click();
    await settle();
    await w.tick(2000);
    assert(!$('.topbar #providers') && !$('#settings-dialog')?.open, 'Connection setup is outside the main workspace');
    for (const width of [1280, 900, 760, 641, 640, 390, 320]) {
      frame.style.width = `${width}px`;
      await settle();
      const toolbar = $('.composer-toolbar').getBoundingClientRect();
      const controls = ['#model-button', '.environment-control', '.worktree-control', '#options-open', '#run-selected']
        .map((selector) => $(selector).getBoundingClientRect());
      assert(
        controls.every((box) => box.left >= toolbar.left && box.right <= toolbar.right && box.top >= toolbar.top && box.bottom <= toolbar.bottom),
        `Composer controls stay inside the toolbar at ${width}px`,
      );
      assert(
        Math.max(...controls.map((box) => box.height)) - Math.min(...controls.map((box) => box.height)) <= 1,
        `Environment, worktree and action controls have consistent heights at ${width}px`,
      );
      assert(
        controls.every((a, i) => controls.slice(i + 1).every((b) =>
          a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom)),
        `Environment and worktree pickers do not overlap adjacent controls at ${width}px`,
      );
      const selectedLabel = $('#environment .select-value');
      assert(
        selectedLabel.clientWidth >= selectedLabel.scrollWidth,
        `Local development stays readable at ${width}px`,
      );
    }
    frame.style.width = '1280px';
    const worktrees = w.fixtureWorktrees;
    w.fixtureWorktrees = [];
    await w.tick(10000);
    assert(
      $('#worktree').disabled && $('#worktree .select-value').textContent === 'No worktrees found',
      'An empty worktree catalog shows an explanatory disabled option',
    );
    w.fixtureWorktrees = worktrees;
    await w.tick(10000);
    assert(!$('#worktree').disabled && $('#worktree').value === '/test/tree', 'Worktree discovery restores the enabled picker');
    w.fixtureWorktrees = [
      ...worktrees,
      { path: '/test/second-checkout', branch: 'feature/verification', subject: 'Another checkout of the same branch' },
      ...Array.from({ length: 18 }, (_, i) => ({
        path: `/test/checkout-${i}`,
        branch: `feature/${'long-branch-name-'.repeat(5)}${i}`,
        subject: 'A long branch and path must wrap inside the menu',
      })),
    ];
    await w.tick(10000);
    for (const [width, height] of [[1280, 800], [539, 700], [390, 640], [320, 568], [844, 390]]) {
      frame.style.width = `${width}px`;
      frame.style.height = `${height}px`;
      await settle();
      const menu = await openPicker('#worktree');
      const box = menu.getBoundingClientRect();
      const list = menu.querySelector('.picker-list');
      const footer = menu.querySelector('.picker-footer').getBoundingClientRect();
      assert(
        box.left >= 0 && box.right <= w.innerWidth && box.top >= 0 && box.bottom <= w.innerHeight &&
          box.bottom <= $('.composer').getBoundingClientRect().top - 7 && menu.scrollWidth <= menu.clientWidth,
        `Worktree menu fits above the composer at ${width}×${height}`,
      );
      assert(
        list.scrollHeight > list.clientHeight && list.getBoundingClientRect().bottom <= footer.top + 1,
        `Long worktree lists scroll separately from the footer at ${width}×${height}`,
      );
      menu.querySelector('.picker-footer button').click();
      await settle();
    }
    frame.style.width = '1280px';
    frame.style.height = '800px';
    const treeMenu = await openPicker('#worktree');
    const treeSearch = treeMenu.querySelector('input');
    assert(d.activeElement === treeSearch, 'Worktree picker focuses search when opened');
    setInput(treeSearch, 'no-such-worktree');
    treeSearch.dispatchEvent(new w.Event('input', { bubbles: true }));
    await settle();
    assert(treeMenu.querySelector('[role="status"]')?.textContent === 'No matching options', 'Picker search explains an empty result');
    setInput(treeSearch, 'second-checkout');
    treeSearch.dispatchEvent(new w.Event('input', { bubbles: true }));
    await settle();
    assert(
      treeMenu.querySelectorAll('[role="option"]').length === 1 && treeMenu.textContent.includes('/test/second-checkout'),
      'Worktree search distinguishes identical branch names by path',
    );
    treeSearch.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    treeSearch.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await settle();
    assert(
      $('#worktree').value === '/test/second-checkout' && d.activeElement === $('#worktree') && !treeMenu.isConnected,
      'Keyboard selection applies the filtered worktree and restores focus',
    );
    await w.tick(10000);
    assert($('#worktree').value === '/test/second-checkout', 'Refreshing the catalog retains the selected worktree');
    await chooseOption('#worktree', '/test/tree');
    w.fixtureWorktrees = worktrees;
    await w.tick(10000);
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
      $('.model-unavailable').textContent.includes('API billing') &&
        $('.model-unavailable').textContent.includes('Reconnect') &&
        !$('#model-list [data-model]'),
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
    $('[data-close="settings-dialog"]').click();
    await settle();
    await chooseOption('#environment', 'staging');
    assert(
      $('.worktree-control').hidden && $('#role').value === 'admin',
      'Hosted selection uses only that environment’s users and hides worktree selection',
    );
    w.fixtureWorktrees = [];
    await w.tick(10000);
    assert(!$('#run-selected').disabled, 'Hosted verification does not require a local worktree');
    $('#options-open').click();
    await settle();
    const users = await openPicker('#role');
    assert(users.querySelectorAll('[role="option"]').length === 2, 'Test-user picker contains only users in the selected environment');
    users.querySelector('[data-value="viewer"]').click();
    await settle();
    assert($('#options-dialog').open && d.activeElement === $('#role'), 'Nested picker closes without dismissing Run options');
    $('[data-close="options-dialog"]').click();
    await settle();
    await chooseOption('#environment', 'local');
    assert(
      $('#role').value === 'test-user' && !$('.worktree-control').hidden,
      'Changing environments resets the test user to a valid member',
    );
    await chooseOption('#environment', 'staging');
    assert($('#role').value === 'viewer', 'Each environment remembers its own test-user selection');
    $('#settings-open').click();
    await settle();
    $('[data-edit-environment="staging"]').click();
    await settle();
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
    w.fixtureWorktrees = worktrees;
    await w.tick(10000);
    $('[data-close="settings-dialog"]').click();
    await settle();
    $('#options-open').click();
    await settle();
    assert($('#authoring').value === 'auto', 'Run options default to compatible saved-spec reuse');
    assert($('#coverage-mode').value === 'live', 'Run options default to the live backend');
    await chooseOption('#coverage-mode', 'mocked');
    for (const [width, height] of [
      [1280, 800],
      [539, 700],
      [390, 640],
      [320, 568],
    ]) {
      frame.style.width = `${width}px`;
      frame.style.height = `${height}px`;
      await settle();
      const dialog = $('#options-dialog');
      const body = dialog.querySelector('.dialog-body');
      const rect = dialog.getBoundingClientRect();
      const head = dialog.querySelector('.dialog-head').getBoundingClientRect();
      const content = body.getBoundingClientRect();
      const footer = dialog.querySelector('.dialog-actions').getBoundingClientRect();
      assert(
        rect.left >= 0 &&
          rect.right <= w.innerWidth &&
          rect.top >= 0 &&
          rect.bottom <= w.innerHeight &&
          dialog.scrollWidth <= dialog.clientWidth &&
          body.scrollWidth <= body.clientWidth,
        `Mock options fit the ${width}px viewport without horizontal overflow`,
      );
      assert(
        content.top >= head.bottom - 1 &&
          content.bottom <= footer.top + 1 &&
          footer.bottom <= rect.bottom &&
          footer.top >= 0 &&
          footer.bottom <= w.innerHeight,
        `Run options keep the header, scrolling form and footer separate at ${width}px`,
      );
      for (const field of dialog.querySelectorAll('.field')) {
        const label = field.querySelector('label').getBoundingClientRect();
        const control = field.querySelector('input, .select-trigger, textarea');
        const box = control.getBoundingClientRect();
        assert(
          label.right <= box.left || label.bottom <= box.top || label.left >= box.right || label.top >= box.bottom,
          `${control.id} does not overlap its label at ${width}px`,
        );
        if (control.classList.contains('select-trigger')) {
          const text = control.querySelector('.select-value');
          assert(text.scrollWidth <= text.clientWidth, `${control.id} shows the selected option without clipping at ${width}px`);
        }
      }
    }
    frame.style.width = '1280px';
    frame.style.height = '800px';
    await chooseOption('#coverage-mode', 'live');
    await chooseOption('#authoring', 'fresh');
    $('[data-close="options-dialog"]').click();
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
        request.body.userId === 'test-user' &&
        request.body.forceFresh === true,
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
      if ($(selector).classList.contains('select-trigger')) return chooseOption(selector, value);
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
    $('#model-dialog [data-close]').click();
    frame.style.width = '1280px';
    frame.style.height = '800px';
    $('#cases-tab').click();
    await settle();
    $('[data-select="DEMO-6003"]').click();
    await settle();
    const removeCase = () => $('[aria-label="Archive case DEMO-6003"]');
    $('[aria-label="Actions for case DEMO-6003"]').click();
    await settle();
    removeCase().focus();
    assert(d.activeElement === removeCase(), 'Sidebar remove controls are keyboard focusable');
    w.rejectRemoval = true;
    removeCase().click();
    await settle();
    assert(
      removeCase() &&
        !removeCase().disabled &&
        $('[data-select="DEMO-6003"]').checked &&
        $('#run-error').textContent.includes('Case changed'),
      'Failed case removal reports the conflict and preserves selection for retry',
    );
    w.rejectRemoval = false;
    $('[aria-label="Actions for case DEMO-6003"]').click();
    await settle();
    removeCase().click();
    await settle();
    assert(
      !removeCase() && $('#clear-selection').hidden && !$('#selection-preview').textContent,
      'Removing a selected case clears its draft selection',
    );
    assert(w.requests.at(-1).body.expectedRevision === 'case-6003', 'Sidebar archival sends the displayed case revision');
    await w.tick(5000);
    assert(
      !$('[data-select="DEMO-6003"]') && $('#case-count').textContent === '1',
      'Archived cases stay absent on refresh and update the count',
    );
    w.fixtureCases.push({ project: 'LOCAL', id: 2, revision: 'draft-2', status: 'draft', title: 'Removable draft', steps: 0 });
    await w.tick(5000);
    assert(!$('[aria-label="Archive case LOCAL-2"]').disabled, 'Draft cases can also be removed');
    $('[aria-label="Archive case LOCAL-2"]').click();
    await settle();
    assert(!$('[data-select="LOCAL-2"]'), 'Removing a draft does not require activating it');
    $('#history-tab').click();
    await settle();
    $('[data-open-job="workspace-test"]').click();
    await settle();
    const removeRun = () => $('[aria-label="Archive run workspace-test"]');
    for (const status of ['queued', 'running', 'cancelling']) {
      w.fixtureJob.status = status;
      await w.tick(2000);
      const count = w.requests.length;
      removeRun().click();
      await settle();
      assert(
        removeRun().disabled && removeRun().title.includes('finish') && w.requests.length === count,
        `A ${status} run cannot be removed or implicitly cancelled`,
      );
    }
    $('#cases-tab').click();
    await settle();
    $('[aria-label="Archive case DEMO-6004"]').click();
    await settle();
    assert(
      $('#view-title').textContent === 'DEMO-6003' && w.fixtureJob.status === 'cancelling',
      'Removing another case does not select it or disturb the open run',
    );
    w.fixtureJob.status = 'done';
    await w.tick(2000);
    $('#history-tab').click();
    await settle();
    assert(!removeRun().disabled && !removeRun().closest('button button'), 'Finished run removal is separate from the open-run button');
    w.rejectRemoval = true;
    removeRun().click();
    await settle();
    assert(
      $('#view-title').textContent === 'DEMO-6003' && removeRun() && $('#run-error').textContent.includes('Removal failed'),
      'Failed run removal preserves the workspace and reports an error',
    );
    w.rejectRemoval = false;
    removeRun().click();
    await settle();
    assert(!removeRun() && !$('#jobs .job') && !$('#welcome').hidden, 'Removing the selected run clears its workspace card');
    assert(
      w.localStorage.getItem('active-job') === null && $('#history-count').textContent === '',
      'Removing the selected run clears its saved selection and history count',
    );
    await w.tick(2000);
    assert(!$('[data-open-job="workspace-test"]') && !$('#jobs .job'), 'Polling does not restore a removed run');
    const remount = async () => {
      const saved = { job: w.fixtureJob, cases: w.fixtureCases, preferences: [...w.fixturePreferences] };
      const reloaded = new Promise((resolve) => {
        frame.onload = resolve;
      });
      frame.srcdoc = html.replace('</head>', '<script>(' + bootstrap.toString() + ')(' + JSON.stringify(saved) + ');</script></head>');
      await reloaded;
      await waitFor(() => [...frame.contentWindow.fixtureTimers.values()].some((t) => t.ms === 5000));
      return frame.contentDocument;
    };
    const refreshed = await remount();
    assert(
      !refreshed.querySelector('#cases .case') && !refreshed.querySelector('#jobs .job'),
      'A fresh workspace keeps archived cases and removed runs absent',
    );
    w.fixturePreferences.set('active-job', JSON.stringify('workspace-test'));
    const historical = await remount();
    assert(
      historical.querySelector('#jobs video') && !historical.querySelector('[data-open-job="workspace-test"]'),
      'Opening retained historical evidence does not restore its sidebar row',
    );
    return { passed: checks.length, checks };
  } catch (error) {
    return { failed: error.message, passed: checks.length, checks };
  } finally {
    frame.remove();
  }
})();
