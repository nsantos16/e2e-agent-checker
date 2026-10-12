import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { stageTools } from './stage-tools.ts';
const service = await stageTools(JSON.parse(readFileSync(process.argv[2], 'utf8')));
const server = new Server({ name: 'e2e-stage', version: '0.3.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: service.tools }));
server.setRequestHandler(CallToolRequestSchema, async (r) => service.call(r.params.name, r.params.arguments ?? {}));
process.stdin.once('end', () => {
  void service.close().finally(() => process.exit(0));
});
await server.connect(new StdioServerTransport());
