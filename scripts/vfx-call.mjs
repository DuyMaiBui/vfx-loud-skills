// Call one VFX Skill Cloud MCP tool from the shell, for sessions that started before vfx-skill was registered.
// Usage: node scripts/vfx-call.mjs <tool> '<json args>'   e.g. node scripts/vfx-call.mjs vfx_search '{"query":"metal spark","limit":5}'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [tool, rawArgs = '{}'] = process.argv.slice(2);
if (!tool) {
  console.error('usage: node scripts/vfx-call.mjs <tool> \'<json args>\'');
  process.exit(2);
}

const base = process.env.VFX_SERVER ?? 'http://127.0.0.1:8787';
const client = new Client({ name: 'vfx-call', version: '0.0.1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));

const r = await client.callTool({ name: tool, arguments: JSON.parse(rawArgs) });
console.log((r.content ?? []).map((c) => c.text ?? '').join('\n'));
await client.close();
process.exit(r.isError === true ? 1 : 0);
