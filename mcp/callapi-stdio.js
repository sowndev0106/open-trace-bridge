// MCP stdio server: expose one call_api tool and forward to Express /internal/call-api.
// Run by opencode through workspaces/<slug>/opencode.json; do not run manually.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const SLUG = process.env.OTB_PROJECT_SLUG;
const BASE = process.env.OTB_BASE || 'http://127.0.0.1:6666';
const TOKEN = process.env.OTB_INTERNAL_TOKEN;

const server = new McpServer({ name: 'otb', version: '1.0.0' });

server.tool(
  'call_api',
  'Call an internal API declared for the project. Read AGENTS.md for available groups, endpoints, and params. The server attaches the API key.',
  {
    group: z.string().describe('API group name. See AGENTS.md.'),
    method: z.string().default('GET').describe('HTTP method, usually GET.'),
    path: z.string().describe('Relative path under the base URL, for example /transactions/txn_123.'),
    params: z.record(z.string(), z.string()).optional().describe('Query params'),
  },
  async ({ group, method, path, params }) => {
    const resp = await fetch(`${BASE}/internal/call-api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-otb-internal-token': TOKEN },
      body: JSON.stringify({ slug: SLUG, group, method, path, params: params || {} }),
      signal: AbortSignal.timeout(35000),
    });
    const data = await resp.json();
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }
);

server.connect(new StdioServerTransport()).catch((err) => {
  console.error('MCP server failed:', err);
  process.exit(1);
});
