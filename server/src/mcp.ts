import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.ts';
import * as store from './store.ts';

const ResourceTypeEnum = z.enum(store.RESOURCE_TYPES);

/** Stateless: 1 server + 1 transport mới cho mỗi request (đơn giản, không lưu session). */
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: config.serverName,
    version: config.serverVersion,
  });

  server.registerTool(
    'vfx_search',
    {
      title: 'Search VFX knowledge',
      description:
        'Tìm asset/knowledge VFX (texture, shader, code, recipe, component, vfx). ' +
        'Trả về Knowledge Card + vfx:// URI, KHÔNG trả binary. ' +
        'Bước đầu tiên của mọi yêu cầu tạo/sửa VFX: tìm cái đã có trước khi tạo mới.',
      inputSchema: {
        query: z.string().describe('Mô tả tiếng Anh, vd "cartoon ground impact soft dust"'),
        type: ResourceTypeEnum.optional().describe('Chỉ tìm 1 loại resource'),
        tags: z.array(z.string()).optional().describe('Lọc theo tag'),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ query, type, tags, limit }) => {
      const cards = await store.search({ query, type, tags, limit });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ count: cards.length, cards }, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    'vfx_resolve',
    {
      title: 'Resolve a vfx:// URI',
      description:
        'Giải mã vfx:// URI -> manifest: metadata, dependencies, download_url. ' +
        'Chưa tải file — dùng vfx_fetch khi đã chọn.',
      inputSchema: { uri: z.string().describe('vd vfx://texture/soft-dust/1') },
    },
    async ({ uri }) => {
      const manifest = await store.resolve(uri);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(manifest, null, 2) }],
      };
    },
  );

  server.registerTool(
    'vfx_fetch',
    {
      title: 'Fetch a vfx:// asset',
      description:
        'Lấy download_url + sha256 để tải file về project. Tool KHÔNG ghi file — ' +
        'client tự tải (scripts/vfx-fetch.sh hoặc Unity menu TheOne/VFX Cloud). ' +
        'Mục tiêu mặc định: Assets/VFXCloud/<type>/<slug>/',
      inputSchema: { uri: z.string() },
    },
    async ({ uri }) => {
      const manifest = await store.resolve(uri);
      const { row, buffer } = await store.readFile(uri);
      const { createHash } = await import('node:crypto');
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                uri: row.uri,
                mime: row.mime,
                bytes: row.bytes,
                file_name: manifest.file_name,
                sha256,
                download_url: manifest.download_url,
                target_hint: `Assets/VFXCloud/${row.type}/${row.slug}/${manifest.file_name}`,
                fetch_command: `scripts/vfx-fetch.sh ${row.uri}`,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'vfx_publish',
    {
      title: 'Publish a VFX resource back to the cloud',
      description:
        'Đóng góp resource mới (texture/shader/code/recipe/component/vfx) lên cloud. ' +
        'CHỈ publish khi đã validate trong Unity và knowledge đáng reuse. ' +
        'license là bắt buộc, "unknown" bị từ chối. Tạo version mới, không overwrite.',
      inputSchema: {
        type: ResourceTypeEnum,
        slug: z.string().describe('a-z, 0-9, "-"  vd soft-dust-03'),
        name: z.string(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        style: z.array(z.string()).optional(),
        category: z.string().optional(),
        license: z.string().describe('cc0 | mit | synty-store-eula | asset-store-eula | internal | ...'),
        file_path: z
          .string()
          .optional()
          .describe('Đường dẫn file trên MÁY CHẠY SERVER (dev local dùng cái này)'),
        b64: z.string().optional().describe('Nội dung file base64 (khi server ở remote)'),
        file_name: z.string().optional(),
        dependencies: z
          .array(z.string())
          .optional()
          .describe('vfx:// URI mà resource này dùng — server tự phát hiện từ payload text, liệt kê thêm nếu cần'),
        meta: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (args) => {
      const result = await store.publish({
        type: args.type,
        slug: args.slug,
        name: args.name,
        description: args.description,
        tags: args.tags,
        style: args.style,
        category: args.category,
        license: args.license,
        localPath: args.file_path,
        b64: args.b64,
        fileName: args.file_name,
        dependencies: args.dependencies,
        meta: args.meta,
        createdBy: 'mcp',
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  return server;
}

export async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): Promise<void> {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
