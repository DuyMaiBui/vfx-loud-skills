import http from 'node:http';
import { config } from './config.ts';
import { migrate } from './db.ts';
import { buildHttp } from './http.ts';
import { handleMcp } from './mcp.ts';
import { countResources } from './store.ts';

async function main(): Promise<void> {
  await migrate();

  const app = await buildHttp();
  await app.ready();

  // /mcp chạy ngoài Fastify để giữ nguyên request stream cho MCP transport.
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (url === '/mcp' || url.startsWith('/mcp?')) {
      handleMcp(req, res, undefined).catch((err) => {
        app.log.error(err);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      return;
    }
    app.routing(req, res);
  });

  await new Promise<void>((resolve) =>
    server.listen(config.port, config.host, resolve),
  );

  const n = await countResources();
  const base = `http://127.0.0.1:${config.port}`;
  console.log(`[vfx-skill-cloud] listening on ${base}`);
  console.log(`  MCP   : ${base}/mcp   (POST, Streamable HTTP, stateless)`);
  console.log(`  Health: ${base}/healthz`);
  console.log(`  Data  : ${config.dataDir}`);
  console.log(`  Rows  : ${n}  embedder=${config.embedder}`);
  console.log(
    `  Auth  : ${config.authDisabled ? 'DISABLED (dev)' : 'x-vfx-key required'}`,
  );

  const shutdown = async () => {
    console.log('\n[vfx-skill-cloud] shutting down');
    server.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[vfx-skill-cloud] failed to start:', err);
  process.exit(1);
});
