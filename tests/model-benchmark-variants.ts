import assert from 'node:assert/strict';
import type { ToolService } from '../src/providers/codex.ts';

// Experimental control: keep the revised implementation and every other tool
// identical, removing only the generic browser batch from the model's interface.
export function withoutBrowserBatch(service: ToolService): ToolService {
  return {
    ...service,
    tools: service.tools.filter((tool) => tool.name !== 'browser_batch'),
    call: (name, args, signal) =>
      name === 'browser_batch'
        ? Promise.resolve({
            content: [
              {
                type: 'text',
                text: 'Tool not available in this comparison arm',
              },
            ],
            isError: true,
          })
        : service.call(name, args, signal),
  };
}

export function withoutBatchGuidance(prompt: string): string {
  const instruction = /^   Use `browser_batch`[^\n]*\n/gm;
  assert.equal([...prompt.matchAll(instruction)].length, 1, 'Expected exactly one batch-specific instruction');
  const revised = prompt
    .replace(instruction, '')
    .replace('The batch stops after', 'Browser tools stop after')
    .replace('or resubmit the batch', 'or repeat the sequence');
  assert(!revised.includes('browser_batch'), 'Batch-only guidance remains in the control prompt');
  return revised;
}
