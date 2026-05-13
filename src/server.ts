import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { tools } from './tools/index.js';

async function main() {
  const server = new Server(
    { name: 'library', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  const byName = new Map(tools.map((t) => [t.name, t] as const));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) throw new Error(`library: unknown tool "${request.params.name}"`);
    try {
      const text = await tool.handler(request.params.arguments ?? {});
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`library server crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
