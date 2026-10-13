import { api, errorMessage, preferences, type Api } from './api.ts';
import { caseKey, terminal } from './format.ts';
import type { CaseSummary, Environment, JobView, Provider, Target, Worktree } from './types.ts';
export type DialogName = 'models' | 'settings' | 'options' | 'import' | null;
export type WorkspaceState = {
  cases: CaseSummary[];
  jobs: JobView[];
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
  dialog: DialogName;
  error: string;
  submitting: boolean;
  refreshingProviders: boolean;
  theme: string;
  ready: boolean;
};
export function createWorkspace(request: Api = api) {
  const savedTargets = preferences.json<unknown>('run-targets', []);
  const targets = Array.isArray(savedTargets)
    ? savedTargets
        .filter(
          (target): target is Target =>
            target &&
            ['codex', 'claude-code', 'cursor'].includes(target.provider) &&
            typeof target.model === 'string' &&
            target.authMode === 'subscription',
        )
        .slice(0, 8)
    : [];
  let state: WorkspaceState = {
    cases: [],
    jobs: [],
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
    state.targets.filter((t) => state.providers.some((p) => p.id === t.provider && p.ready && p.models.some((m) => m.id === t.model)));
  const setEnvironments = (environments: Environment[]) => {
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
      const cases = await call<CaseSummary[]>('/api/cases');
      patch({
        cases,
        selected: new Set(
          [...state.selected].filter((key) => cases.some((c) => caseKey(c) === key && (!c.status || c.status === 'active'))),
        ),
      });
    });
  const refreshJobs = () =>
    once('jobs', async () => {
      let jobs = await call<JobView[]>('/api/jobs');
      const id = state.activeJob;
      if (id && !jobs.some((j) => j.id === id) && state.details[id]) {
        const detail = await call<JobView>(`/api/jobs/${encodeURIComponent(id)}`);
        if (state.activeJob === id) jobs = [detail, ...jobs];
      }
      const open = jobs.filter((j) => state.expanded.has(j.id) && terminal(j));
      const details = await Promise.all(open.map((j) => call<JobView>(`/api/jobs/${encodeURIComponent(j.id)}`)));
      // Selection can change while evidence requests are in flight. Keep its already-loaded card.
      const selected = state.jobs.find((job) => job.id === state.activeJob);
      if (selected && !jobs.some((job) => job.id === selected.id)) jobs = [selected, ...jobs];
      patch({ jobs, details: { ...state.details, ...Object.fromEntries(details.map((d) => [d.id, d])) } });
    });
  const refreshProviders = () =>
    once('providers', async () => {
      patch({ refreshingProviders: true });
      try {
        const providers = await call<Provider[]>('/api/providers?fresh=1');
        let targets = state.targets;
        if (!targets.length) {
          const p = providers.find((p) => p.ready && p.models.length);
          if (p) targets = [{ provider: p.id, model: p.models[0].id, authMode: 'subscription' }];
        }
        patch({ providers, targets });
      } finally {
        patch({ refreshingProviders: false });
      }
    });
  const refreshEnvironments = () => once('environments', async () => setEnvironments(await call<Environment[]>('/api/environments')));
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
    patch({ details: { ...state.details, [id]: detail } });
  };
  const run = async (keys = [...state.selected]) => {
    if (state.submitting) return;
    if (!keys.length) {
      report(new Error('Select at least one case.'));
      return;
    }
    if (!state.targets.length || readyTargets().length !== state.targets.length) {
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
      const ids = await call<string[]>('/api/jobs', {
        cases: keys.map((key) => {
          const [project, id] = key.split(/-(?=\d+$)/);
          return { project, id: Number(id) };
        }),
        worktree: environment()?.kind === 'hosted' ? undefined : state.worktree,
        environmentId: state.environmentId,
        userId: state.userId,
        targets: state.targets,
        limits,
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
    refreshProviders,
    refreshEnvironments,
    setEnvironments,
    beginDraft,
    selectJob,
    toggleExpanded,
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
    toggleTarget(target: Target) {
      const exists = state.targets.some((t) => t.provider === target.provider && t.model === target.model);
      const targets = exists
        ? state.targets.filter((t) => t.provider !== target.provider || t.model !== target.model)
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
            const config = await call<{ environments?: Environment[]; roles: string[] }>('/api/config');
            if (generation === epoch)
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
