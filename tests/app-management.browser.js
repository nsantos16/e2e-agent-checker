// Exercise sidebar organization and lifecycle controls without running verifications.
(async () => {
  const checks = [];
  const assert = (ok, message) => {
    if (!ok) throw new Error(message);
    checks.push(message);
  };
  const html = await (await fetch('/')).text();
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;left:-10000px;width:1280px;height:800px;border:0';
  const bootstrap = (saved) => {
    Object.defineProperty(document, 'hidden', { value: false });
    const preferences = new Map(saved?.preferences ?? []);
    window.fixturePreferences = preferences;
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: (k) => preferences.get(k) ?? null,
        setItem: (k, v) => preferences.set(k, v),
        removeItem: (k) => preferences.delete(k),
      },
    });
    const timers = new Map();
    let timerId = 0;
    window.fixtureTimers = timers;
    window.setInterval = (fn, ms) => {
      timers.set(++timerId, { fn, ms });
      return timerId;
    };
    window.clearInterval = (id) => timers.delete(id);
    window.tick = async (ms) => {
      for (const timer of timers.values()) if (timer.ms === ms) await timer.fn();
      await new Promise((r) => setTimeout(r, 40));
    };
    const baseJob = {
      project: 'LOCAL',
      caseId: 1,
      status: 'done',
      worktree: '',
      role: 'test',
      createdAt: '2026-01-01T00:00:00Z',
      log: [],
      steps: [],
    };
    const data = saved?.data ?? {
      cases: [
        { project: 'LOCAL', id: 1, revision: '1', status: 'active', title: 'Alpha case', steps: 1 },
        { project: 'LOCAL', id: 2, revision: '1', status: 'draft', title: 'Draft case', steps: 0 },
        { project: 'DEMO', id: 3, revision: '1', status: 'active', title: 'Other project', steps: 1 },
      ],
      jobs: [
        { ...baseJob, id: 'first', title: 'Finished run' },
        { ...baseJob, id: 'second', title: 'Working run', status: 'running' },
        { ...baseJob, id: 'third', title: 'Other run' },
      ],
      settings: { revision: '1', runCacheAfterDays: null },
    };
    window.fixtureData = data;
    window.requests = [];
    const organize = (item, changes) => {
      if (changes.pinned !== undefined) {
        item.pinnedAt = changes.pinned ? 'now' : undefined;
        if (changes.pinned) item.settledAt = undefined;
      }
      if (changes.settled !== undefined) {
        item.settledAt = changes.settled ? 'now' : undefined;
        if (changes.settled) item.pinnedAt = undefined;
      }
    };
    window.fetch = async (path, options) => {
      if (options?.method === 'POST') {
        const body = JSON.parse(options.body);
        window.requests.push({ path, body });
        if (path === '/api/settings') {
          data.settings = { ...body.settings, revision: String(Number(data.settings.revision) + 1) };
          return Response.json(data.settings);
        }
        if (path === '/api/storage/cleanup')
          return Response.json({
            at: new Date().toISOString(),
            removed: [{ id: 'first', bytes: 100 }],
            skipped: [{ id: 'second', reason: 'Active' }],
            failed: [],
          });
        if (path === '/api/sidebar/order') {
          const records = body.kind === 'case' ? data.cases : data.jobs;
          const changed = body.ids.map((id, sortOrder) => {
            const item = records.find((i) => (body.kind === 'case' ? `${i.project}-${i.id}` : i.id) === id);
            item.sortOrder = sortOrder;
            return item;
          });
          return Response.json(changed);
        }
        const caseMatch = path.match(/^\/api\/cases\/([^/]+)\/(\d+)\/(delete|restore|remove|organize)$/);
        if (caseMatch) {
          const [, project, id, action] = caseMatch,
            item = data.cases.find((c) => c.project === project && c.id === Number(id));
          if (body.expectedRevision !== item.revision) return Response.json({ error: 'Revision conflict' }, { status: 409 });
          if (action === 'delete') {
            item.archivedFromStatus = item.status;
            item.status = 'archived';
          }
          if (action === 'restore') item.status = item.archivedFromStatus;
          if (action === 'remove') item.deletedAt = 'now';
          if (action === 'organize') organize(item, body.changes);
          item.revision = String(Number(item.revision) + 1);
          return Response.json(item);
        }
        const jobMatch = path.match(/^\/api\/jobs\/([^/]+)\/(remove|restore|delete|organize)$/);
        if (jobMatch) {
          const [, id, action] = jobMatch,
            item = data.jobs.find((j) => j.id === id);
          if (action === 'remove') item.hiddenAt = new Date().toISOString();
          if (action === 'restore') delete item.hiddenAt;
          if (action === 'delete') item.deletedAt = 'now';
          if (action === 'organize') organize(item, body);
          return Response.json(item);
        }
        throw new Error('Unexpected mutation ' + path);
      }
      if (path === '/api/config') return Response.json({ roles: [], environments: [] });
      if (path.startsWith('/api/cases'))
        return Response.json(data.cases.filter((c) => !c.deletedAt && (path.includes('includeArchived=1') || c.status !== 'archived')));
      if (path === '/api/jobs') return Response.json(data.jobs.filter((j) => !j.hiddenAt && !j.deletedAt));
      if (path.startsWith('/api/jobs?archived=1')) return Response.json(data.jobs.filter((j) => j.hiddenAt && !j.deletedAt));
      if (path.includes('/observation'))
        return Response.json({
          browser: null,
          network: { total: 0, errorCount: 0, dropped: 0, matching: 0, requests: [], capturedStages: [] },
        });
      if (path.startsWith('/api/jobs/')) return Response.json(data.jobs.find((j) => path === '/api/jobs/' + j.id));
      if (path === '/api/settings') return Response.json(data.settings);
      if (path === '/api/storage/cleanup') return Response.json(null);
      return Response.json([]);
    };
  };
  const mount = async (saved) => {
    const loaded = new Promise((resolve) => {
      frame.onload = resolve;
    });
    frame.srcdoc = html.replace(
      '</head>',
      '<script>(' + bootstrap.toString() + ')(' + JSON.stringify(saved ?? null) + ');</script></head>',
    );
    if (!frame.isConnected) document.body.append(frame);
    await loaded;
    for (let i = 0; i < 100; i++) {
      if ([...frame.contentWindow.fixtureTimers.values()].some((t) => t.ms === 5000)) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('Workspace did not become ready');
  };
  try {
    await mount();
    let w = frame.contentWindow,
      d = w.document;
    const $ = (selector) => d.querySelector(selector);
    const settle = () => new Promise((r) => setTimeout(r, 50));
    const menu = async (label) => {
      $(`[aria-label="Actions for ${label}"]`).click();
      await settle();
    };
    const choose = async (text) => {
      const button = [...d.querySelectorAll('.item-menu:popover-open button')].find((b) => b.textContent.trim() === text);
      if (!button) throw new Error('Missing menu action: ' + text);
      button.click();
      await settle();
    };
    const settings = async (tab) => {
      $('#settings-open').click();
      await settle();
      $(`[data-settings-tab="${tab}"]`).click();
      await settle();
    };
    const closeSettings = async () => {
      $('[data-close="settings-dialog"]').click();
      await settle();
    };
    const setValue = (element, value) => {
      Object.getOwnPropertyDescriptor(
        element.tagName === 'SELECT' ? w.HTMLSelectElement.prototype : w.HTMLInputElement.prototype,
        'value',
      ).set.call(element, value);
      element.dispatchEvent(new w.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    };
    assert($('#cases section[aria-label="LOCAL"]') && $('#cases section[aria-label="DEMO"]'), 'Cases appear in project folders');
    assert(
      $('#history section[aria-label="LOCAL"] section[aria-label="Working"]'),
      'The default view combines project folders and status sections',
    );
    $('[aria-label="Actions for case LOCAL-1"]').dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await settle();
    assert($('.item-menu:popover-open'), 'Right-clicking the action button opens its menu');
    await choose('Pin');
    assert($('#cases section[aria-label="Pinned"] [data-key="LOCAL-1"]'), 'Pin moves a case above project folders');
    $('#cases section[aria-label="LOCAL"] .group-header').click();
    await settle();
    assert(
      $('#cases section[aria-label="LOCAL"] .group-header').getAttribute('aria-expanded') === 'false',
      'Project folders collapse and retain a count',
    );
    await settings('sidebar');
    $('#sidebar-grouping').click();
    await settle();
    $('#sidebar-grouping-picker [data-value="status"]').click();
    await settle();
    await closeSettings();
    $('#history-tab').click();
    await settle();
    assert(
      $('#history section[aria-label="Working"]') && $('#history section[aria-label="Active"]'),
      'Status mode separates working and active runs',
    );
    await menu('run second');
    assert(
      [...d.querySelectorAll('.item-menu:popover-open button')]
        .filter((b) => ['Archive', 'Delete…', 'Settle'].includes(b.textContent.trim()))
        .every((b) => b.disabled),
      'Working runs cannot be archived, deleted or settled',
    );
    $('.item-menu:popover-open').hidePopover();
    await settle();
    await menu('run third');
    await choose('Move up');
    assert(
      $('#history section[aria-label="Active"] [data-open-job]').dataset.openJob === 'third',
      'Move up persists the order within a section',
    );
    await menu('run first');
    await choose('Settle');
    assert($('#history section[aria-label="Settled"] [data-open-job="first"]'), 'Finished runs can be settled without archiving');
    await menu('run first');
    await choose('Unsettle');
    $('[data-open-job="first"]').click();
    await settle();
    await menu('run first');
    await choose('Archive');
    assert(!$('[data-open-job="first"]') && !$('#welcome').hidden, 'Archiving the selected run closes its workspace');
    $('.undo-notice button').click();
    await settle();
    assert(
      $('[data-open-job="first"]') && $('#view-title').textContent === 'LOCAL-1',
      'Undo archive restores the selected run and reopens it',
    );
    $('#cases-tab').click();
    await settle();
    await menu('case LOCAL-2');
    await choose('Archive');
    await settings('archived');
    assert($('#archived-settings').textContent.includes('Draft case'), 'Settings lists archived cases');
    $('[aria-label="Unarchive case LOCAL-2"]').click();
    await settle();
    await closeSettings();
    assert($('[data-select="LOCAL-2"]').disabled, 'Restoring a draft keeps it a draft');
    await menu('case LOCAL-2');
    await choose('Delete…');
    assert($('#delete-item-dialog').open && $('[data-select="LOCAL-2"]'), 'Permanent deletion first opens a confirmation');
    [...d.querySelectorAll('#delete-item-dialog button')].find((b) => b.textContent === 'Cancel').click();
    await settle();
    assert($('[data-select="LOCAL-2"]'), 'Cancelling deletion keeps the item');
    await menu('case LOCAL-2');
    await choose('Delete…');
    [...d.querySelectorAll('#delete-item-dialog button')].find((b) => b.textContent === 'Delete permanently').click();
    await settle();
    await w.tick(5000);
    assert(!$('[data-select="LOCAL-2"]'), 'Confirmed deletion remains absent after catalog refresh');
    $('#history-tab').click();
    await settle();
    await menu('run first');
    await choose('Archive');
    await settings('archived');
    assert($('#archived-settings').textContent.includes('Finished run'), 'Settings lists archived runs separately from deleted cases');
    $('[data-archived-item="run:first"]').dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await settle();
    await choose('Delete');
    [...d.querySelectorAll('#delete-item-dialog button')].find((b) => b.textContent === 'Delete permanently').click();
    await settle();
    assert(!$('#archived-settings').textContent.includes('Finished run'), 'Deleting an archived run removes it from the archive');
    $('[data-settings-tab="storage"]').click();
    await settle();
    assert(!$('#cache-cleanup-enabled').checked && $('#cache-retention-days').disabled, 'Automatic cache deletion starts off');
    $('#cache-cleanup-enabled').click();
    await settle();
    setValue($('#cache-retention-days'), '0');
    await settle();
    const before = w.requests.length;
    $('#storage-settings form').requestSubmit();
    await settle();
    assert(w.requests.length === before, 'Retention rejects a zero-day limit');
    setValue($('#cache-retention-days'), '14');
    await settle();
    $('#storage-settings form').requestSubmit();
    await settle();
    assert(
      w.fixtureData.settings.runCacheAfterDays === 14 && $('#storage-settings').textContent.includes('Storage settings saved'),
      'A custom day limit is persisted explicitly',
    );
    [...d.querySelectorAll('#storage-settings button')].find((b) => b.textContent === 'Delete now').click();
    await settle();
    assert(
      $('#storage-settings').textContent.includes('1 run caches cleaned') && $('#storage-settings').textContent.includes('1 protected'),
      'Manual cleanup displays removed and protected runs',
    );
    await closeSettings();
    const saved = { data: w.fixtureData, preferences: [...w.fixturePreferences] };
    await mount(saved);
    w = frame.contentWindow;
    d = w.document;
    assert(
      w.fixturePreferences.get('sidebar-grouping') === 'status' && $('#cases section[aria-label="Pinned"]'),
      'Grouping and pins survive a fresh workspace',
    );
    assert(!$('[data-select="LOCAL-2"]') && !$('[data-open-job="first"]'), 'Deleted items do not return in a fresh workspace');
    await settings('storage');
    assert(
      $('#cache-cleanup-enabled').checked && $('#cache-retention-days').value === '14',
      'Retention settings survive a fresh workspace',
    );
    frame.style.width = '390px';
    await settle();
    assert(
      d.documentElement.scrollWidth <= w.innerWidth && $('#settings-dialog').getBoundingClientRect().right <= w.innerWidth,
      'Management settings fit a mobile viewport',
    );
    return { passed: checks.length, checks };
  } catch (error) {
    return { failed: error.message, passed: checks.length, checks };
  } finally {
    frame.remove();
  }
})();
