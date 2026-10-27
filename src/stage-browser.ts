import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { ToolService } from './providers/codex.ts';
import { browserSections, browserState, clip, IMAGE_BYTES, RESULT_BYTES, resultBytes, StageEvidence, toolJson } from './stage-results.ts';

const MAX_CALL_MS = 120_000;
type ActionResult = {
  index: number;
  tool: string;
  status: 'completed' | 'failed' | 'uncertain' | 'unexecuted';
  evidenceId?: string;
  error?: string;
  assertion?: 'passed' | 'failed';
  result?: string;
  resultTruncated?: boolean;
  diagnostics?: string;
  imageCount?: number;
};

// This is an orchestration wrapper over the existing driver, not a new execution sandbox.
// The enclosing stage semaphore owns each complete call, including reads and cleanup.
export function browserTools(
  backend: ToolService,
  evidence: StageEvidence,
  config: { actionsPath?: string; runDir?: string },
): ToolService {
  const validator = new AjvJsonSchemaValidator();
  const validators = new Map(backend.tools.map((tool) => [tool.name, validator.getValidator(tool.inputSchema)]));
  let halted = false;
  const record = (value: unknown) => {
    if (config.runDir) {
      const path = join(config.runDir, 'explore/actions.jsonl');
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(evidence.clean(value)) + '\n', {
        mode: 0o600,
      });
    }
  };
  const source = (value: string) => {
    if (config.actionsPath) {
      mkdirSync(dirname(config.actionsPath), { recursive: true });
      appendFileSync(config.actionsPath, evidence.cleanText(value), {
        mode: 0o600,
      });
    }
  };
  const callAction = async (tool: string, args: any, signal?: AbortSignal) => {
    try {
      if (typeof tool !== 'string' || !tool.length || tool.length > 100) throw new Error('Invalid tool name');
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object');
      if (resultBytes(args) > 65_536) throw new Error('Tool arguments exceed 64 KiB');
    } catch (error) {
      return toolJson(
        { status: 'rejected', completed: [], unexecuted: 'all', error: clip(evidence.cleanText(String(error)), 1_200) },
        true,
      );
    }
    const action = { tool, arguments: args };
    const row: ActionResult = { index: 1, tool, status: 'unexecuted' };
    // Preserve the existing result/evidence envelope. A code snippet is one
    // driver call; its individual statements are not separately instrumented.
    const rows = [row];
    const timeoutMs = MAX_CALL_MS;
    let error: string | undefined;
    let state: ReturnType<typeof browserState> = {};
    let stateAfterAction: number | undefined;
    let images: any[] = [];
    // Validate against the existing driver's schema before any mutation.
    const validate = validators.get(tool);
    const checked = validate?.(args);
    if (!checked?.valid) error = `Action rejected: ${validate ? checked?.errorMessage : 'Tool not permitted'}`;
    if (halted) error = 'Browser halted after an uncertain outcome. Do not retry mutations; inspect saved evidence.';
    const expiresAt = Date.now() + timeoutMs;
    const deadline = AbortSignal.timeout(timeoutMs);
    const cancel = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const expired = () => deadline.aborted || Date.now() >= expiresAt;
    dispatch: {
      if (error) break dispatch;
      if (cancel.aborted || expired()) {
        error = expired() ? 'Browser call timed out before dispatch' : 'Browser call cancelled before dispatch';
        break dispatch;
      }
      const id = randomUUID();
      const startedAt = new Date().toISOString();
      // Start records survive a process crash and clearly distinguish dispatched from queued work.
      try {
        record({
          id,
          index: row.index,
          tool: action.tool,
          arguments: action.arguments,
          status: 'started',
          startedAt,
        });
        // The full submitted arguments remain in the audit log and evidence. Do
        // not duplicate code/input values in the codification source view.
        source(`// ${action.tool}; started; evidenceId=${id}\n`);
      } catch (failure) {
        error = `Action history unavailable before dispatch: ${failure}`;
        break dispatch;
      }
      // Synchronous history I/O can exhaust a deadline before the abort timer gets a turn.
      if (cancel.aborted || expired()) {
        error = expired() ? 'Browser call timed out before dispatch' : 'Browser call cancelled before dispatch';
        record({ id, index: row.index, tool: action.tool, status: 'unexecuted', error });
        source(`// unexecuted: ${error}\n`);
        break dispatch;
      }
      let raw: any;
      let sections: Record<string, string> = {};
      try {
        raw = await backend.call(action.tool, action.arguments, cancel);
        sections = browserSections(raw);
        if (cancel.aborted || expired() || /\b(?:TimeoutError|timed out|timeout \d+ms exceeded)\b/i.test(sections.Error ?? '')) {
          throw new Error(
            expired() ? 'Browser call timed out during action' : cancel.aborted ? 'Browser call cancelled during action' : sections.Error,
          );
        }
        row.status = raw.isError || sections.Error ? 'failed' : 'completed';
        if (row.status === 'failed') row.error = sections.Error || sections.Result || 'Browser tool rejected the action';
        const isAssertion =
          action.tool.startsWith('browser_verify_') ||
          (action.tool === 'browser_wait_for' && !!(action.arguments.text || action.arguments.textGone));
        if (isAssertion) row.assertion = row.status === 'completed' ? 'passed' : 'failed';
      } catch (failure) {
        row.status = 'uncertain';
        row.error = String(failure);
        halted = true;
        // An aborted MCP request need not mean the remote mutation stopped. Close the
        // transport before releasing the stage lock; never dispatch or retry on it again.
        await backend.close().catch(() => {});
      }
      row.evidenceId = id;
      const cleanSections = evidence.clean(sections) as Record<string, string>;
      const detail = {
        id,
        index: row.index,
        tool: action.tool,
        arguments: action.arguments,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: row.status,
        assertion: row.assertion,
        error: row.error,
        response: raw
          ? {
              ...raw,
              content: (raw.content ?? []).map((c: any) =>
                c.type === 'image'
                  ? {
                      type: c.type,
                      mimeType: c.mimeType,
                      encodedBytes: c.data?.length,
                    }
                  : c,
              ),
            }
          : undefined,
      };
      // Save all driver code blocks and the audit record BEFORE any result clipping.
      try {
        record(detail);
        source(`// ${row.status}${row.assertion ? `; assertion ${row.assertion}` : ''}\n`);
        for (const c of raw?.content ?? [])
          if (c.type === 'text') {
            for (const match of String(c.text).matchAll(
              /^### Ran Playwright code\s*```(?:js|ts|javascript|typescript)?\r?\n([\s\S]*?)^```[ \t]*\r?$/gm,
            ))
              source(match[1].trim() + '\n');
          }
        if (row.status !== 'completed') source(`// Outcome: ${JSON.stringify(evidence.cleanText(row.error ?? row.status))}\n`);
        evidence.save(detail, id);
        const actionImages = (raw?.content ?? []).filter((c: any) => c.type === 'image');
        row.imageCount = actionImages.length || undefined;
        actionImages.slice(0, 8).forEach((image: unknown, index: number) => evidence.saveImage(id, index, image));
      } catch (failure) {
        row.evidenceId = undefined;
        error = `Action history could not be saved after dispatch: ${failure}`;
        halted = true;
        await backend.close().catch(() => {});
      }
      row.error = row.error ? clip(evidence.cleanText(row.error), 1_200) : undefined;
      row.result = cleanSections.Result ? clip(cleanSections.Result, 800) : undefined;
      row.resultTruncated = row.result !== undefined && row.result !== cleanSections.Result ? true : undefined;
      row.diagnostics = cleanSections['Network diagnostics'] ? clip(cleanSections['Network diagnostics'], 1_200) : undefined;
      const currentState = browserState(cleanSections);
      if (Object.keys(currentState).length) {
        state = currentState;
        stateAfterAction = row.index;
      }
      images = (raw?.content ?? []).filter((c: any) => c.type === 'image').slice(0, 1);
      if (row.status !== 'completed') error ??= row.error ?? 'Action failed';
    }
    const summary = {
      status: error ? 'stopped' : 'completed',
      error: error ? clip(evidence.cleanText(error), 1_200) : undefined,
      completed: rows.filter((r) => r.status === 'completed').map((r) => r.index),
      unexecuted: rows.filter((r) => r.status === 'unexecuted').map((r) => r.index),
      actions: rows,
      stateAfterAction,
      state,
      stateOmitted: false,
      note: error ? 'A dispatched action may have mutated the page. Do not automatically retry it; inspect its evidenceId.' : undefined,
    };
    let batchEvidenceId: string | undefined;
    try {
      batchEvidenceId = evidence.save({ kind: 'browser_batch', ...summary });
      record({ kind: 'batch', evidenceId: batchEvidenceId, ...summary });
    } catch (failure) {
      error = summary.error = `Call history could not be saved: ${failure}`;
      summary.status = 'stopped';
      halted = true;
      await backend.close().catch(() => {});
    }
    // Bound the encoded response, including JSON escaping. Always keep outcome/index/ID.
    let result: any = toolJson({ ...summary, batchEvidenceId }, !!error);
    if (resultBytes(result) > RESULT_BYTES) {
      summary.state = {};
      summary.stateOmitted = true;
      summary.error = summary.error ? clip(summary.error, 600) : undefined;
      for (const row of rows) {
        row.error = row.error ? clip(row.error, 600) : undefined;
        if (row.result && resultBytes(row.result) > 200) {
          row.result = clip(row.result, 200);
          row.resultTruncated = true;
        }
        row.diagnostics = undefined;
      }
      result = toolJson({ ...summary, batchEvidenceId }, !!error);
    }
    if (images.length && resultBytes(images) <= IMAGE_BYTES) result.content.push(...images);
    else if (images.length)
      result.content.push({
        type: 'text',
        text: 'Image exceeded the 1 MiB response limit; request a smaller screenshot.',
      });
    return result;
  };
  return { tools: backend.tools, close: backend.close, call: callAction };
}
