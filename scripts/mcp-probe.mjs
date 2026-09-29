import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = process.env.VFX_SERVER ?? 'http://127.0.0.1:8787';
const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
const client = new Client({ name: 'vfx-probe', version: '0.0.1' });
await client.connect(transport);

const tools = await client.listTools();
console.log(
  'tools:',
  tools.tools.map((t) => t.name).join(', '),
);

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content ?? []).map((c) => c.text ?? '').join('\n');
  return { isError: r.isError === true, text };
}

// G2 — search
const s = await call('vfx_search', { query: 'cartoon ground impact', limit: 5 });
console.log('\n== vfx_search ==\n' + s.text);

// G3 — resolve + fetch
const first = JSON.parse(s.text).cards[0];
const f = await call('vfx_fetch', { uri: first.uri });
console.log('\n== vfx_fetch ==\n' + f.text);

// G4 — publish then search immediately
const payload = Buffer.from('probe recipe\n').toString('base64');
const p = await call('vfx_publish', {
  type: 'recipe',
  slug: `probe-${Date.now()}`,
  name: 'Probe publish canary',
  description: 'temporary probe entry for smoke test',
  tags: ['probe', 'canary'],
  license: 'cc0',
  b64: payload,
  file_name: 'probe.yaml',
});
console.log('\n== vfx_publish ==\n' + p.text);
const publishedUri = JSON.parse(p.text).uri;
const s2 = await call('vfx_search', { query: 'probe canary', limit: 3 });
const found = JSON.parse(s2.text).cards.some((c) => c.uri === publishedUri);
console.log('\n== G4 re-search hit ==', found ? 'PASS' : 'FAIL', publishedUri);

// G5 — recolor (compute only, nothing written): pick a recolorable card and shift its hue.
const rs = await call('vfx_search', { query: 'fire muzzle flash', limit: 20 });
const recolorable = JSON.parse(rs.text).cards.find((c) => c.recolorable === true);
if (!recolorable) {
  console.log('\n== G5 recolor == FAIL no recolorable card in search results');
} else {
  const r = await call('vfx_recolor', { uri: recolorable.uri, hueShiftDeg: 120, includePayload: false });
  const j = r.isError ? {} : JSON.parse(r.text);
  const good = !r.isError && Array.isArray(j.changes) && j.changes.length > 0 && Array.isArray(j.tint);
  console.log('\n== G5 recolor ==', good ? 'PASS' : 'FAIL', recolorable.uri, good ? `${j.changes.length} keys` : r.text.slice(0, 200));
}

await client.close();
