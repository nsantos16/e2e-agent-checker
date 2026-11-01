import { providerInstanceId, targetInstanceId, sameTarget, targetSchema } from '../../providers/schema.ts';
import { api, errorMessage, preferences, type Api } from './api.ts';
import { caseKey, terminal } from './format.ts';
import type { CaseSummary, Environment, JobView, Provider, Target, Worktree, SidebarItem } from './types.ts';
export type SidebarGrouping = 'project-status' | 'project' | 'status' | 'none';
export type SettingsTab = 'connections' | 'environments' | 'voice' | 'sidebar' | 'archived' | 'storage';
export type DialogName = 'models' | 'settings' | 'options' | 'import' | null;
export type WorkspaceState = {
  cases: CaseSummary[];
  jobs: JobView[];
  archivedCases: CaseSummary[];
  archivedJobs: JobView[];
  sidebarGrouping: SidebarGrouping;
  collapsedGroups: Set<string>;
  settingsTab: SettingsTab;
  confirmDelete: SidebarItem | null;
  undoArchive: { item: SidebarItem; reopen: boolean } | null;
  providers: Provider[];
  worktrees: Worktree[];
  environments: Environment[];
  selected: Set<string>;
  expanded: Set<string>;
  details: Record<string, JobView>;
  targets: Target[];
  activeJob: string | null;
  sidebarTab: 'cases' | 'history';
  sidebarOpen: boolean;
  search: string;
  environmentId: string;
  userId: string;
  worktree: string;
  timeout: number;
  attempts: number;
  forceFresh: boolean;
  mockEnabled: boolean;
  mockBackendRoot: string;
  mockSourceFiles: string;
  mockSchemaFiles: string;
  mockFrontendFiles: string;
  mockAllowedLive: string;
  dialog: DialogName;
  error: string;
  submitting: boolean;
  refreshingProviders: boolean;
  theme: string;
  ready: boolean;
};
export function createWorkspace(request: Api = api) {
  const savedTargets = preferences.json<unknown>('run-targets', []);
  const savedGroups = preferences.json<unknown>('collapsed-groups', []);
  const targets = Array.isArray(savedTargets)
    ? savedTargets
        .flatMap((target) => {
          const parsed = targetSchema.safeParse(target);
          return parsed.success ? [parsed.data] : [];
        })
        .slice(0, 8)
    : [];
  let state: WorkspaceState = {
    cases: [],
    jobs: [],
    archivedCases: [],
    archivedJobs: [],
    sidebarGrouping: (['project-status', 'project', 'status', 'none'].includes(preferences.get('sidebar-grouping') ?? '')
      ? preferences.get('sidebar-grouping')
      : 'project-status') as SidebarGrouping,
    collapsedGroups: new Set(Array.isArray(savedGroups) ? savedGroups.filter((key): key is string => typeof key === 'string') : []),
    settingsTab: 'connections',
    confirmDelete: null,
    undoArchive: null,
    providers: [],
    worktrees: [],
    environments: [],
    selected: new Set(),
    expanded: new Set(),
    details: {},
    targets,
    activeJob:
      (typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('job')) ?? preferences.json('active-job', null),
    sidebarTab: 'cases',
    sidebarOpen: false,
    search: '',
    environmentId: preferences.get('environment') ?? '',
    userId: '',
    worktree: preferences.get('worktree') ?? '',
    timeout: 20,
    attempts: 8,
    forceFresh: false,
    mockEnabled: false,
    mockBackendRoot: '',
    mockSourceFiles: '',
    mockSchemaFiles: '',
    mockFrontendFiles: '',
    mockAllowedLive: '[{"method":"GET","url":"/","resourceTypes":["document"],"reason":"Frontend entry page"}]',
    dialog: null,
    error: '',
    submitting: false,
    refreshingProviders: false,
    theme: preferences.get('theme') === 'light' ? 'light' : 'dark',
    ready: false,
  };
  const listeners = new Set<() => void>();
  let controller = new AbortController();
  let started = false;
  let generation = 0;
  let caseMutation = 0;
  let jobMutation = 0;
  let environmentVersion = 0;
  const pending = new Map<string, Promise<void>>();
  const patch = (changes: Partial<WorkspaceState>) => {
    state = { ...state, ...changes };
    listeners.forEach((fn) => fn());
  };
  const report = (error: unknown) => {
    if (!controller.signal.aborted && !(error instanceof Error && error.name === 'AbortError')) patch({ error: errorMessage(error) });
  };
  const call: Api = async <T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
    const currentSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    currentSignal.throwIfAborted();
    const result = await request<T>(path, body, currentSignal);
    currentSignal.throwIfAborted();
    return result;
  };
  const once = (key: string, task: () => Promise<void>) => {
    const existing = pending.get(key);
    if (existing) return existing;
    const promise = task().finally(() => {
      if (pending.get(key) === promise) pending.delete(key);
    });
    pending.set(key, promise);
    return promise;
  };
  const updateUrl = (id: string | null) => {
    if (typeof location === 'undefined' || !/^https?:$/.test(location.protocol)) return;
    const url = new URL(location.href);
    if (id) url.searchParams.set('job', id);
    else url.searchParams.delete('job');
    history.replaceState(null, '', url);
  };
  const environment = () => state.environments.find((e) => e.id === state.environmentId);
  const readyTargets = () =>
    state.targets.filter((t) =>
      state.providers.some(
        (p) =>
          providerInstanceId(p) === targetInstanceId(t) &&
          p.ready &&
          (!t.instanceRevision || t.instanceRevision === p.revision) &&
          (!t.accountFingerprint || t.accountFingerprint === p.accountFingerprint) &&
          p.models.some((m) => m.id === t.model),
      ),
    );
  const setEnvironments = (environments: Environment[]) => {
    environmentVersion++;
    const selected = environments.find((e) => e.id === state.environmentId) ?? environments[0];
    const remembered =
      selected?.id === state.environmentId
        ? state.userId || preferences.get('test-user:' + selected.id)
        : preferences.get('test-user:' + selected?.id);
    patch({
      environments,
      environmentId: selected?.id ?? '',
      userId: selected?.users.find((u) => u.id === remembered)?.id ?? selected?.users[0]?.id ?? '',
    });
  };
  const refreshCases = () =>
    once('cases', async () => {
      const version = caseMutation;
      const cases = await call<CaseSummary[]>('/api/cases');
      if (version !== caseMutation) return;
      patch({
        cases,
        selected: new Set(
          [...state.selected].filter((key) => cases.some((c) => caseKey(c) === key && (!c.status || c.status === 'active'))),
        ),
      });
    });
  const jobPages = async (path = '/api/jobs') => {
    let page = await call<JobView[]>(path);
    const jobs = [...page];
    let pageSize = path.includes('limit=1000') ? 1000 : 60;
    let cursor = page.length;
    while (page.length === pageSize) {
      pageSize = 1000;
      const url = new URL(path, 'http://localhost');
      url.searchParams.set('cursor', String(cursor));
      url.searchParams.set('limit', '1000');
      page = await call<JobView[]>(url.pathname + url.search);
      jobs.push(...page);
      cursor += page.length;
    }
    return [...new Map(jobs.map((job) => [job.id, job])).values()];
  };
  const refreshJobs = () =>
    once('jobs', async () => {
      const version = jobMutation;
      let jobs = await jobPages();
      const missing = new Set<string>();
      const readDetail = async (id: string) => {
        try {
          return await call<JobView>(`/api/jobs/${encodeURIComponent(id)}`);
        } catch (error) {
          if ((error as { status?: number }).status !== 404) throw error;
          missing.add(id);
        }
      };
      const id = state.activeJob;
      if (id && !jobs.some((j) => j.id === id) && state.details[id]) {
        const detail = await readDetail(id);
        if (detail && state.activeJob === id) jobs = [detail, ...jobs];
      }
      const open = jobs.filter((j) => state.expanded.has(j.id) && terminal(j));
      const loaded = await Promise.all(open.map((j) => readDetail(j.id)));
      // A poll started before removal must not put the item or its evidence back.
      if (version !== jobMutation) return;
      const details = { ...state.details };
      missing.forEach((id) => delete details[id]);
      for (const detail of loaded) if (detail) details[detail.id] = detail;
      jobs = jobs.filter((job) => !missing.has(job.id));
      const activeJob = state.activeJob && !missing.has(state.activeJob) ? state.activeJob : null;
      if (activeJob !== state.activeJob) {
        preferences.set('active-job', null);
        updateUrl(null);
      }
      // Selection can change while evidence requests are in flight. Keep its already-loaded card.
      const selected = state.jobs.find((job) => job.id === activeJob);
      if (selected && !jobs.some((job) => job.id === selected.id)) jobs = [selected, ...jobs];
      patch({ jobs, details, activeJob, expanded: new Set([...state.expanded].filter((id) => !missing.has(id))) });
    });
  const refreshArchive = () =>
    once('archive', async () => {
      const version = `${caseMutation}:${jobMutation}`;
      const [cases, jobs] = await Promise.all([
        call<CaseSummary[]>('/api/cases?includeArchived=1'),
        jobPages('/api/jobs?archived=1&limit=1000'),
      ]);
      if (version !== `${caseMutation}:${jobMutation}`) return;
      patch({ archivedCases: cases.filter((c) => c.status === 'archived'), archivedJobs: jobs });
    });
  const refreshProviders = (fresh = true) =>
    once('providers', async () => {
      patch({ refreshingProviders: true });
      try {
        const providers = await call<Provider[]>('/api/providers' + (fresh ? '?fresh=1' : ''));
        let targets = state.targets;
        if (!targets.length) {
          const p = providers.find((p) => p.selected && p.ready && p.models.length) ?? providers.find((p) => p.ready && p.models.length);
          if (p)
            targets = [
              {
                provider: p.id,
                instanceId: providerInstanceId(p),
                instanceRevision: p.revision,
                accountFingerprint: p.accountFingerprint,
                model: p.models[0].id,
                authMode: 'subscription',
              },
            ];
        }
        patch({ providers, targets });
      } finally {
        patch({ refreshingProviders: false });
      }
    });
  const refreshEnvironments = () =>
    once('environments', async () => {
      const version = environmentVersion;
      const environments = await call<Environment[]>('/api/environments');
      // Settings may have installed a newer catalog while this poll was in flight.
      if (version === environmentVersion) setEnvironments(environments);
    });
  const refreshWorktrees = () =>
    once('worktrees', async () => {
      const worktrees = await call<Worktree[]>('/api/worktrees');
      patch({ worktrees, worktree: worktrees.some((w) => w.path === state.worktree) ? state.worktree : (worktrees[0]?.path ?? '') });
    });
  const beginDraft = (clear = true) => {
    preferences.set('active-job', null);
    updateUrl(null);
    patch({ activeJob: null, expanded: new Set(), ...(clear ? { selected: new Set<string>() } : {}), sidebarTab: 'cases', search: '' });
  };
  const selectJob = async (id: string) => {
    patch({ activeJob: id, expanded: new Set([...state.expanded, id]), sidebarTab: 'history', search: '', sidebarOpen: false });
    preferences.set('active-job', JSON.stringify(id));
    updateUrl(id);
    const detail = await call<JobView>(`/api/jobs/${encodeURIComponent(id)}`);
    if (state.activeJob !== id) return;
    patch({
      details: { ...state.details, [id]: detail },
      jobs: state.jobs.some((j) => j.id === id) ? state.jobs : [detail, ...state.jobs],
    });
  };
  const toggleExpanded = async (id: string) => {
    const expanded = new Set(state.expanded);
    if (expanded.has(id)) {
      expanded.delete(id);
      patch({ expanded });
      return;
    }
    expanded.add(id);
    patch({ expanded });
    const detail = await call<JobView>(`/api/jobs/${encodeURIComponent(id)}`);
    if (!state.expanded.has(id)) return;
    patch({ details: { ...state.details, [id]: detail } });
  };
  const removeCase = (testCase: CaseSummary) =>
    once('remove-case:' + caseKey(testCase), async () => {
      patch({ error: '' });
      const archived = await call<CaseSummary>(`/api/cases/${encodeURIComponent(testCase.project)}/${testCase.id}/delete`, {
        expectedRevision: testCase.revision,
      });
      caseMutation++;
      const key = caseKey(testCase);
      patch({
        cases: state.cases.filter((c) => caseKey(c) !== key),
        selected: new Set([...state.selected].filter((selected) => selected !== key)),
        undoArchive: { item: { kind: 'case', value: { ...testCase, ...archived } }, reopen: false },
      });
    });
  const removeJob = (id: string) =>
    once('remove-job:' + id, async () => {
      patch({ error: '' });
      await call(`/api/jobs/${encodeURIComponent(id)}/remove`, {});
      jobMutation++;
      const details = { ...state.details };
      delete details[id];
      const active = state.activeJob === id;
      const job = state.jobs.find((j) => j.id === id);
      if (active) {
        preferences.set('active-job', null);
        updateUrl(null);
      }
      patch({
        jobs: state.jobs.filter((job) => job.id !== id),
        details,
        expanded: new Set([...state.expanded].filter((expanded) => expanded !== id)),
        ...(active ? { activeJob: null } : {}),
        ...(job ? { undoArchive: { item: { kind: 'run' as const, value: job }, reopen: active } } : {}),
      });
    });
  const restoreItem = async (item: SidebarItem, reopen = false) => {
    if (item.kind === 'case') {
      const restored = await call<CaseSummary>(`/api/cases/${item.value.project}/${item.value.id}/restore`, {
        expectedRevision: item.value.revision,
      });
      caseMutation++;
      patch({
        cases: [...state.cases.filter((c) => caseKey(c) !== caseKey(restored)), restored],
        archivedCases: state.archivedCases.filter((c) => caseKey(c) !== caseKey(restored)),
      });
    } else {
      await call(`/api/jobs/${encodeURIComponent(item.value.id)}/restore`, {});
      jobMutation++;
      const restored = { ...item.value, hiddenAt: undefined };
      patch({
        jobs: [...state.jobs.filter((j) => j.id !== restored.id), restored],
        archivedJobs: state.archivedJobs.filter((j) => j.id !== restored.id),
      });
      if (reopen) await selectJob(restored.id);
    }
    patch({ undoArchive: null });
  };
  const deleteItem = async (item: SidebarItem) => {
    if (item.kind === 'case') {
      await call(`/api/cases/${item.value.project}/${item.value.id}/remove`, { expectedRevision: item.value.revision });
      caseMutation++;
      const key = caseKey(item.value);
      patch({
        cases: state.cases.filter((c) => caseKey(c) !== key),
        archivedCases: state.archivedCases.filter((c) => caseKey(c) !== key),
        selected: new Set([...state.selected].filter((k) => k !== key)),
      });
    } else {
      const id = item.value.id;
      await call(`/api/jobs/${encodeURIComponent(id)}/delete`, {});
      jobMutation++;
      if (state.activeJob === id) {
        preferences.set('active-job', null);
        updateUrl(null);
      }
      const details = { ...state.details };
      delete details[id];
      patch({
        jobs: state.jobs.filter((j) => j.id !== id),
        archivedJobs: state.archivedJobs.filter((j) => j.id !== id),
        details,
        expanded: new Set([...state.expanded].filter((key) => key !== id)),
        activeJob: state.activeJob === id ? null : state.activeJob,
      });
    }
    patch({ confirmDelete: null, undoArchive: null });
  };
  const organize = async (item: SidebarItem, changes: { pinned?: boolean; settled?: boolean; sortOrder?: number }) => {
    if (item.kind === 'case') {
      const c = await call<CaseSummary>(`/api/cases/${item.value.project}/${item.value.id}/organize`, {
        expectedRevision: item.value.revision,
        changes,
      });
      caseMutation++;
      patch({ cases: state.cases.map((old) => (caseKey(old) === caseKey(c) ? c : old)) });
    } else {
      const result = await call<Partial<JobView>>(`/api/jobs/${encodeURIComponent(item.value.id)}/organize`, changes);
      jobMutation++;
      patch({
        jobs: state.jobs.map((j) =>
          j.id === item.value.id ? { ...j, pinnedAt: result.pinnedAt, settledAt: result.settledAt, sortOrder: result.sortOrder } : j,
        ),
      });
    }
  };
  const run = async (keys = [...state.selected]) => {
    if (state.submitting) return;
    if (!keys.length) {
      report(new Error('Select at least one case.'));
      return;
    }
    if (!state.targets.length || (state.forceFresh && readyTargets().length !== state.targets.length)) {
      patch({ dialog: 'models', error: 'Choose an available model before running.' });
      return;
    }
    if (!environment() || !state.userId || (environment()?.kind !== 'hosted' && !state.worktree)) {
      report(new Error('Choose an environment, test user and worktree before running.'));
      return;
    }
    const limits = { timeoutMs: state.timeout * 60000, maxAttempts: state.attempts };
    if (
      !Number.isFinite(limits.timeoutMs) ||
      !Number.isInteger(limits.maxAttempts) ||
      limits.maxAttempts < 1 ||
      limits.maxAttempts > 8 ||
      limits.timeoutMs < 60000 ||
      limits.timeoutMs > 3600000
    ) {
      report(new Error('Use 1–60 minutes and 1–8 test attempts.'));
      return;
    }
    const runnable = keys.every((key) => state.cases.some((c) => caseKey(c) === key && (!c.status || c.status === 'active')));
    if (!runnable) {
      report(new Error('Activate the selected cases before running.'));
      return;
    }
    patch({ submitting: true, error: '' });
    try {
      const files = (text: string) =>
        text
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
      const mockSuite = state.mockEnabled
        ? {
            backendRoot: state.mockBackendRoot,
            sourceFiles: files(state.mockSourceFiles),
            schemaFiles: files(state.mockSchemaFiles),
            frontendFiles: files(state.mockFrontendFiles),
            allowedLiveRequests: JSON.parse(state.mockAllowedLive),
          }
        : undefined;
      const ids = await call<string[]>('/api/jobs', {
        mockSuite,
        cases: keys.map((key) => {
          const [project, id] = key.split(/-(?=\d+$)/);
          return { project, id: Number(id) };
        }),
        worktree: environment()?.kind === 'hosted' ? undefined : state.worktree,
        environmentId: state.environmentId,
        userId: state.userId,
        targets: state.targets,
        limits,
        forceFresh: state.forceFresh,
        idempotencyKey: crypto.randomUUID(),
      });
      patch({ selected: new Set() });
      await refreshJobs();
      if (ids[0]) await selectJob(ids[0]);
    } catch (error) {
      report(error);
    } finally {
      patch({ submitting: false });
    }
  };
  const store = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    patch,
    report,
    api: call,
    environment,
    readyTargets,
    refreshCases,
    refreshJobs,
    refreshArchive,
    refreshProviders,
    refreshEnvironments,
    setEnvironments,
    beginDraft,
    selectJob,
    toggleExpanded,
    removeCase,
    removeJob,
    restoreItem,
    deleteItem,
    organize,
    async reorderItems(items: SidebarItem[]) {
      if (!items.length) return;
      const kind = items[0].kind;
      const ids = items.map((item) => (item.kind === 'case' ? caseKey(item.value) : item.value.id));
      if (kind === 'case') {
        const updated = await call<CaseSummary[]>('/api/sidebar/order', { kind, ids });
        caseMutation++;
        const byKey = new Map(updated.map((c) => [caseKey(c), c]));
        patch({ cases: state.cases.map((c) => byKey.get(caseKey(c)) ?? c) });
      } else {
        const updated = await call<{ id: string; sortOrder: number }[]>('/api/sidebar/order', { kind, ids });
        jobMutation++;
        const byId = new Map(updated.map((j) => [j.id, j.sortOrder]));
        patch({ jobs: state.jobs.map((j) => (byId.has(j.id) ? { ...j, sortOrder: byId.get(j.id) } : j)) });
      }
    },
    setSidebarGrouping(sidebarGrouping: SidebarGrouping) {
      preferences.set('sidebar-grouping', sidebarGrouping);
      patch({ sidebarGrouping });
    },
    toggleGroup(key: string) {
      const collapsedGroups = new Set(state.collapsedGroups);
      if (collapsedGroups.has(key)) collapsedGroups.delete(key);
      else collapsedGroups.add(key);
      preferences.set('collapsed-groups', JSON.stringify([...collapsedGroups]));
      patch({ collapsedGroups });
    },
    run,
    showTab(tab: 'cases' | 'history') {
      patch({ sidebarTab: tab, search: '' });
    },
    selectCase(key: string, addOnly = false) {
      if (!state.cases.some((c) => caseKey(c) === key && (!c.status || c.status === 'active'))) return;
      const selected = new Set(state.selected);
      if (selected.has(key) && !addOnly) selected.delete(key);
      else selected.add(key);
      if (state.activeJob) beginDraft(false);
      patch({ selected });
    },
    chooseEnvironment(id: string) {
      const selected = state.environments.find((e) => e.id === id);
      if (!selected) return;
      const remembered = preferences.get('test-user:' + id);
      preferences.set('environment', id);
      patch({ environmentId: id, userId: selected.users.find((u) => u.id === remembered)?.id ?? selected.users[0]?.id ?? '' });
    },
    chooseUser(id: string) {
      preferences.set('test-user:' + state.environmentId, id);
      patch({ userId: id });
    },
    chooseWorktree(path: string) {
      preferences.set('worktree', path);
      patch({ worktree: path });
    },
    setTargetOptions(target: Target, effort: string) {
      const targets = state.targets.map((t) => (sameTarget(t, target) ? { ...t, options: effort ? { effort } : {} } : t));
      preferences.set('run-targets', JSON.stringify(targets));
      patch({ targets });
    },
    async chooseProvider(p: Provider) {
      await call('/api/provider-instances/select', { instanceId: providerInstanceId(p), expectedRevision: p.revision });
      const model = p.models[0];
      const targets: Target[] = model
        ? [
            {
              provider: p.id,
              instanceId: providerInstanceId(p),
              instanceRevision: p.revision,
              accountFingerprint: p.accountFingerprint,
              model: model.id,
              authMode: 'subscription',
            },
          ]
        : [];
      preferences.set('run-targets', JSON.stringify(targets));
      patch({ targets, dialog: 'models' });
      await refreshProviders(false);
    },
    toggleTarget(target: Target) {
      const exists = state.targets.some((t) => sameTarget(t, target));
      const targets = exists
        ? state.targets.filter((t) => !sameTarget(t, target))
        : state.targets.length < 8
          ? [...state.targets, target]
          : state.targets;
      preferences.set('run-targets', JSON.stringify(targets));
      patch({ targets });
    },
    toggleTheme() {
      const theme = state.theme === 'dark' ? 'light' : 'dark';
      preferences.set('theme', theme);
      patch({ theme });
    },
    async jobAction(job: JobView, action: 'cancel' | 'replay' | 'rerun') {
      if (action === 'rerun') {
        const env = state.environments.find((e) => e.id === (job.environmentId ?? state.environmentId));
        if (!env) throw new Error('This run’s environment was deleted. Choose another environment for a new run.');
        if (job.userId && !env.users.some((u) => u.id === job.userId))
          throw new Error('This test user was removed. Choose a user for a new run.');
        beginDraft();
        store.chooseEnvironment(env.id);
        patch({
          selected: new Set([`${job.project}-${job.caseId}`]),
          targets: job.target ? [job.target] : state.targets,
          worktree: job.worktree,
          userId: job.userId ?? state.userId,
          mockEnabled: !!job.mockSuite,
          ...(job.mockSuite
            ? {
                mockBackendRoot: job.mockSuite.backendRoot,
                mockSourceFiles: job.mockSuite.sourceFiles.join('\n'),
                mockSchemaFiles: job.mockSuite.schemaFiles.join('\n'),
                mockFrontendFiles: job.mockSuite.frontendFiles.join('\n'),
                mockAllowedLive: JSON.stringify(job.mockSuite.allowedLiveRequests, null, 2),
              }
            : {}),
        });
        return;
      }
      const result = await call<{ id: string }>(`/api/jobs/${encodeURIComponent(job.id)}/${action}`, {});
      await refreshJobs();
      if (action === 'replay') await selectJob(result.id);
    },
    start() {
      if (started) return () => {};
      started = true;
      controller = new AbortController();
      const epoch = ++generation;
      const timers: ReturnType<typeof setInterval>[] = [];
      const poll = (task: () => Promise<void>, ms: number) =>
        timers.push(
          setInterval(() => {
            if (!document.hidden) void task().catch(report);
          }, ms),
        );
      void (async () => {
        await Promise.all([
          (async () => {
            const version = environmentVersion;
            const config = await call<{
              environments?: Environment[];
              roles: string[];
            }>('/api/config');
            if (generation === epoch && version === environmentVersion)
              setEnvironments(
                config.environments ?? [
                  { id: 'local', name: 'Local development', kind: 'worktree', users: config.roles.map((id) => ({ id, name: id })) },
                ],
              );
          })(),
          refreshCases(),
          refreshWorktrees(),
          refreshProviders(),
          refreshJobs(),
        ]);
        if (generation !== epoch) return;
        if (state.activeJob) {
          try {
            await selectJob(state.activeJob);
          } catch (error) {
            beginDraft();
            report(error);
          }
        }
        if (generation !== epoch) return;
        patch({ ready: true });
        poll(refreshJobs, 2000);
        poll(refreshCases, 5000);
        poll(refreshEnvironments, 10000);
        poll(refreshWorktrees, 10000);
      })().catch(report);
      return () => {
        started = false;
        generation++;
        timers.forEach(clearInterval);
        controller.abort();
        pending.clear();
      };
    },
  };
  return store;
}
export type Workspace = ReturnType<typeof createWorkspace>;
