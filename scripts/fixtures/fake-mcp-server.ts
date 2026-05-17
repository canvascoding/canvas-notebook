import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { appendFileSync } from 'node:fs';

if (process.env.MCP_START_FILE) {
  appendFileSync(process.env.MCP_START_FILE, `${Date.now()}\n`, 'utf8');
}

const server = new McpServer({
  name: 'canvas-fake-mcp-server',
  version: '1.0.0',
});

server.registerTool(
  'echo',
  {
    title: 'Echo',
    description: 'Echoes a message with the configured prefix.',
    inputSchema: {
      message: z.string(),
    },
  },
  async ({ message }) => ({
    content: [{ type: 'text', text: `${process.env.ECHO_PREFIX || ''}${message}` }],
  }),
);

server.registerTool(
  'sum',
  {
    title: 'Sum',
    description: 'Adds two numbers.',
    inputSchema: {
      a: z.number(),
      b: z.number(),
    },
  },
  async ({ a, b }) => ({
    content: [{ type: 'text', text: String(a + b) }],
    structuredContent: { total: a + b },
  }),
);

async function main() {
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
