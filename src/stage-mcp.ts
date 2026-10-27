import { Effect } from 'effect';
import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { stageToolsEffect } from './stage-tools.ts';
import { sdk } from './runtime/effect.ts';
import { runMain } from './runtime/main.ts';
await runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* stageToolsEffect(JSON.parse(readFileSync(process.argv[2], 'utf8')));
      const server = yield* Effect.acquireRelease(
        Effect.sync(() => new Server({ name: 'e2e-stage', version: '0.3.0' }, { capabilities: { tools: {} } })),
        (server) => sdk(() => server.close()).pipe(Effect.orDie),
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: service.tools }));
      server.setRequestHandler(CallToolRequestSchema, async (r, extra) => service.call(r.params.name, r.params.arguments ?? {}, extra.signal));
      yield* sdk(() => server.connect(new StdioServerTransport()));
      yield* Effect.never;
    }),
  ),
  { stdin: true },
);
