import { appendFileSync, writeFileSync } from 'node:fs';
import { codexConnection } from './rpc.ts';
import { codexUsage, emptyUsage, type RunMetrics } from '../usage.ts';
import type { ClaudeOutcome, ClaudeRun } from '../claude.ts';
export type StageTool = { name: string; description: string; inputSchema: Record<string, unknown> };
export type ToolService = { tools: StageTool[]; call: (name: string, args: any) => Promise<any>; close: () => Promise<void> };
export async function runCodex(run: ClaudeRun, service: ToolService): Promise<ClaudeOutcome> {
  const rpc = await codexConnection(run.cwd),
    started = Date.now(),
    events: Record<string, any>[] = [];
  const metrics: RunMetrics = { costUsd: null, turns: 0, toolCalls: 0, wallMs: 0, models: [run.model], usage: emptyUsage('codex') };
  writeFileSync(run.transcriptPath, '', { mode: 0o600 });
  const update = () => {
    metrics.wallMs = Date.now() - started;
    run.onMetrics?.({ ...metrics });
  };
  update();
  let threadId: string | undefined, turnId: string | undefined;
  const abort = () => {
    if (threadId && turnId) void rpc.request('turn/interrupt', { threadId, turnId }, 2000).catch(() => {});
    void rpc.close();
  };
  run.signal?.addEventListener('abort', abort, { once: true });
  try {
    run.signal?.throwIfAborted();
    const account = await rpc.request('account/read', { refreshToken: false });
    if (account.account?.type !== 'chatgpt') throw new Error('AUTH_MODE_MISMATCH: Codex requires ChatGPT login');
    const { config: inherited } = await rpc.request('config/read', { includeLayers: false });
    const disabled = Object.fromEntries(Object.keys(inherited.mcp_servers ?? {}).map((name) => [name, { enabled: false }]));
    let finish!: (turn: any) => void;
    const completion = new Promise<any>((resolve) => {
      finish = resolve;
    });
    const messages = new Map<string, string>();
    rpc.onEvent = (method, p) => {
      if (method.startsWith('account/')) return;
      appendFileSync(run.transcriptPath, JSON.stringify({ method, params: p }) + '\n');
      if (method === 'thread/tokenUsage/updated') {
        const usage = codexUsage(p.tokenUsage.total);
        metrics.usage = run.pricing ? run.pricing.price(usage, metrics.models[0]!) : usage;
        update();
      }
      if (method === 'item/completed' && p.item?.type === 'agentMessage') messages.set(p.item.id, p.item.text);
      if (method === 'turn/started') turnId = p.turn.id;
      if (method === 'turn/completed') finish(p.turn);
    };
    rpc.onRequest = async (method, p) => {
      if (method !== 'item/tool/call' || !service.tools.some((t) => t.name === p.tool)) throw new Error('Tool not permitted');
      run.signal?.throwIfAborted();
      metrics.toolCalls++;
      update();
      run.log?.(`→ ${p.tool}`);
      const result = await service.call(p.tool, p.arguments);
      events.push({ type: 'user', message: { content: [{ type: 'tool_result', content: result.content }] } });
      return {
        success: !result.isError,
        contentItems: (result.content ?? []).flatMap((c: any) =>
          c.type === 'text'
            ? [{ type: 'inputText', text: c.text }]
            : c.type === 'image'
              ? [{ type: 'inputImage', imageUrl: `data:${c.mimeType};base64,${c.data}` }]
              : [],
        ),
      };
    };
    const thread = await rpc.request('thread/start', {
      cwd: run.cwd,
      model: run.model,
      modelProvider: 'openai',
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      environments: [],
      runtimeWorkspaceRoots: [],
      allowProviderModelFallback: false,
      baseInstructions: 'Execute the requested QA stage using only the provided tools. Return the requested JSON report.',
      developerInstructions: 'Do not delegate. Only the supplied stage tools are available.',
      dynamicTools: service.tools.map((t) => ({ type: 'function', ...t })),
      config: {
        forced_login_method: 'chatgpt',
        mcp_servers: disabled,
        apps: { _default: { enabled: false } },
        web_search: 'disabled',
        project_doc_max_bytes: 0,
        notify: [],
        hooks: {},
        agents: { enabled: false },
        orchestrator: { mcp: { enabled: false } },
        cloud: { skills: { enabled: false } },
        features: Object.fromEntries(
          [
            'shell_tool',
            'unified_exec',
            'apply_patch_freeform',
            'multi_agent',
            'multi_agent_v2',
            'collab',
            'apps',
            'connectors',
            'js_repl',
            'code_mode',
            'code_mode_host',
            'code_mode_only',
            'goals',
            'image_generation',
            'imagegenext',
            'computer_use',
            'browser_use',
            'in_app_browser',
            'plugins',
            'remote_plugin',
            'recommended_plugins',
            'tool_search',
            'tool_suggest',
            'skill_search',
            'memories',
            'memory_tool',
            'sleep_tool',
            'hooks',
            'codex_hooks',
            'plugin_hooks',
            'default_mode_request_user_input',
            'send_message_to_user_async',
          ].map((k) => [k, false]),
        ),
        skills: { config: [] },
        memories: { use_memories: false, generate_memories: false },
      },
    });
    threadId = thread.thread.id;
    metrics.models = [thread.model ?? run.model];
    const turn = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: run.prompt }] });
    turnId = turn.turn.id;
    const final = await Promise.race([
      completion,
      rpc.closed.then(() => {
        throw new Error('Codex disconnected before completing the turn');
      }),
    ]);
    run.signal?.throwIfAborted();
    if (final.status !== 'completed') throw new Error(`Codex ${final.status}: ${final.error?.message ?? 'Run did not complete'}`);
    metrics.turns = 1;
    if (metrics.usage.status === 'partial') metrics.usage.status = 'complete';
    update();
    return { exitCode: 0, resultText: [...messages.values()].at(-1) ?? '', events, metrics };
  } finally {
    run.signal?.removeEventListener('abort', abort);
    if (metrics.usage.status === 'pending') metrics.usage.status = 'unavailable';
    update();
    await rpc.close();
  }
}
