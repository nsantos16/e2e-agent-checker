import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { appendFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.STAGE_FIXTURE_DIR!;
const schema = {
  type: 'object' as const,
  properties: { target: { type: 'string' }, value: {} },
  required: ['target'],
  additionalProperties: false,
};
const tools = ['browser_click', 'browser_evaluate', 'browser_snapshot', 'browser_wait_for', 'browser_verify_text'].map((name) => ({
  name,
  description: name,
  inputSchema: schema,
}));
const server = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
  const target = String(params.arguments?.target);
  appendFileSync(join(dir, 'dispatch.jsonl'), JSON.stringify({ tool: params.name, target }) + '\n');
  if (target === 'delayed') await new Promise((resolve) => setTimeout(resolve, 50));
  if (target === 'slow') {
    writeFileSync(join(dir, 'started'), 'yes');
    await new Promise<void>((resolve) =>
      extra.signal.addEventListener(
        'abort',
        () => {
          writeFileSync(join(dir, 'cancelled'), 'yes');
          resolve();
        },
        { once: true },
      ),
    );
    return { content: [{ type: 'text', text: 'cancelled' }], isError: true };
  }
  if (target === 'throw') throw new Error('fixture transport rejection');
  const code = `await page.getByRole('button', { name: '${target}' }).click();`;
  let body = `### Ran Playwright code\n\`\`\`js\n${code}\n\`\`\`\n### Page\n- Page URL: https://fixture.test/home?token=private\n### Result\n${JSON.stringify(params.arguments?.value ?? true)}\n`;
  if (target === 'multi')
    body += `### Ran Playwright code\n\`\`\`ts\nawait page.getByLabel('Second').fill('two');\nawait page.getByLabel('Markdown').fill('a \`\`\` fence');\n\`\`\`\n`;
  if (target === 'reject') body += '### Error\nPermission rejected\n';
  if (target === 'timeout-result') body += '### Error\nTimeoutError: click exceeded its timeout\n';
  if (target === 'modal') body += '### Modal state\nUnexpected confirmation dialog\n';
  const snapshot =
    Array.from({ length: 1500 }, (_, i) => `- button "Item ${i}" [ref=e${i}]`).join('\n') +
    '\n- textbox "Secret" [ref=secret]: fixture-password';
  if (target.startsWith('snapshot-outside')) {
    const outside = join(dir, 'private.yml');
    writeFileSync(outside, 'DO-NOT-READ-OUTSIDE-OUTPUT');
    const path = target === 'snapshot-outside-symlink' ? join(dir, 'output', 'link.yml') : outside;
    if (path !== outside) symlinkSync(outside, path);
    body += `### Snapshot\n- [Snapshot](${path})`;
  } else if (target === 'snapshot-file') {
    const path = join(dir, 'output', 'page.yml');
    writeFileSync(path, snapshot);
    body += `### Snapshot\n- [Snapshot](${path})`;
  } else body += `### Snapshot\n\`\`\`yaml\n${snapshot}\n\`\`\``;
  const content: any[] = [{ type: 'text', text: body }];
  if (target === 'image' || target === 'large-image')
    content.push({
      type: 'image',
      mimeType: 'image/png',
      data:
        target === 'image'
          ? 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='
          : 'a'.repeat(1_100_000),
    });
  return { content, ...(target === 'reject' ? { isError: true } : {}) };
});
await server.connect(new StdioServerTransport());
