// MCP stdio server: expose 1 tool call_api — forward về Express /internal/call-api.
// Chạy bởi opencode (config trong workspaces/<slug>/opencode.json), KHÔNG chạy tay.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const SLUG = process.env.OTB_PROJECT_SLUG;
const BASE = process.env.OTB_BASE || 'http://127.0.0.1:6666';
const TOKEN = process.env.OTB_INTERNAL_TOKEN;

const server = new McpServer({ name: 'otb', version: '1.0.0' });

server.tool(
  'call_api',
  'Gọi API nội bộ đã khai báo cho project. Đọc AGENTS.md để biết group nào có endpoint/params gì. Server tự gắn API key.',
  {
    group: z.string().describe('Tên API group (xem AGENTS.md)'),
    method: z.string().default('GET').describe('HTTP method, thường là GET'),
    path: z.string().describe('Path tương đối dưới base URL, vd /transactions/txn_123'),
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
