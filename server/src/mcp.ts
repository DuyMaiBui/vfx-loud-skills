import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.ts';
import { facets } from './facet-search.ts';
import { FACET_NAMES } from './facets.ts';
import { recolorRecord } from './recolor-service.ts';
import * as store from './store.ts';

const ResourceTypeEnum = z.enum(store.RESOURCE_TYPES);

const FILTERS_HELP =
  `facet filters {facet: [values]}: values within a facet are OR-ed, different facets are AND-ed. Facets: ${FACET_NAMES.join(', ')}. ` +
  'category (explosion, impact, projectile, muzzle, beam, trail, aura, buff, heal, shield, pickup, portal, weather, ambient, ui, blood, smoke, fire, magic), ' +
  'subcategory ("<category>/<sub>", e.g. explosion/ground, impact/slash, projectile/missile), ' +
  'element (fire, water, ice, lightning, poison, earth, wind, light, dark, arcane, blood, smoke, energy), colors, ' +
  'playback (loop | one-shot), duration (short <0.5s | medium | long >2s), scale (small | medium | large), ' +
  'motion (radial, upward, downward, directional, orbit, static, spiral, falling), shape, renderMode, cost (low | medium | high), style.';
const filtersSchema = z.record(z.string(), z.array(z.string())).optional();

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
        'Bước đầu tiên của mọi yêu cầu tạo/sửa VFX: tìm cái đã có trước khi tạo mới. ' +
        'Query hiểu tiếng Anh + tiếng Việt (vd "nổ lửa", "mưa", "hồi máu") và từ đồng nghĩa. ' +
        'Lọc `style` (toon | stylized | retro | sci-fi | low-poly) và `keywords` ' +
        '(element: fire/water/ice/lightning/poison/smoke/blood/earth/wind/magic; ' +
        'use: explosion/impact/muzzle/projectile/beam/buff/heal/shield/trail/pickup/portal/teleport/levelup/slash; ' +
        'weather: rain/snow; colour: red/orange/yellow/green/cyan/blue/purple/pink/white/black/gold; ' +
        'loop: looping | one-shot). ' +
        'Thêm `filters` (facet: category, subcategory, element, colors, playback, duration, scale, motion, shape, renderMode, cost, style) ' +
        'để thu hẹp; mỗi card trả thêm `facets` và `behavior` (mô tả bằng lời cái người xem thấy). ' +
        'Biến thể cùng một effect (khác màu/version) được GỘP thành MỘT card: `variants: [{uri, colors, name}]` liệt kê tất cả (gồm chính card); ' +
        'đặt `collapseVariants: false` để mỗi record là một card riêng. ' +
        '`pairsWith: [{uri, name, category}]` là các effect cùng bộ (vd muzzle + projectile + impact của cùng một loại vũ khí) — gợi ý dùng kèm sau khi user chọn. ' +
        'Xem thêm hàng xóm trong graph bằng vfx_related. ' +
        'Không chắc user muốn gì? Gọi vfx_facets trước để hỏi đúng câu.',
      inputSchema: {
        query: z.string().describe('Mô tả tiếng Anh, vd "cartoon ground impact soft dust"'),
        type: ResourceTypeEnum.optional().describe('Chỉ tìm 1 loại resource'),
        tags: z.array(z.string()).optional().describe('Lọc theo tag'),
        style: z.array(z.string()).optional().describe('Lọc theo pack style: toon, stylized, retro, sci-fi, low-poly ("cartoon", "low poly" cũng được)'),
        keywords: z.array(z.string()).optional().describe('Lọc: record có BẤT KỲ keyword nào (fire, explosion, blue, looping...)'),
        filters: filtersSchema.describe(FILTERS_HELP),
        collapseVariants: z.boolean().optional().describe('Mặc định true: mỗi họ biến thể (màu/version) một card. false: mỗi record một card'),
        limit: z.number().int().min(1).max(50).optional().describe('Số card (sau khi gộp biến thể)'),
      },
    },
    async ({ query, type, tags, style, keywords, filters, limit, collapseVariants }) => {
      const cards = await store.search({ query, type, tags, style, keywords, filters: store.parseFilters(filters), limit, collapseVariants });
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
    'vfx_facets',
    {
      title: 'Facet counts for a VFX query',
      description:
        'Đếm số record theo từng facet (category, subcategory, element, colors, playback, duration, scale, motion, shape, renderMode, cost, style) ' +
        'trong tập ứng viên khớp `query` + `filters`. Dùng để hỏi user câu hẹp đúng chỗ: facet nào còn nhiều giá trị thì hỏi facet đó, ' +
        'rồi gọi lại với `filters` đã chọn, đến khi `total` đủ nhỏ thì vfx_search. ' +
        'Không có `query` = đếm trên toàn bộ record khớp filters. Có `query` = cùng điểm xếp hạng với vfx_search, ' +
        'chỉ giữ record khớp từ khóa (gồm đồng nghĩa / tiếng Việt), tối đa FACET_CANDIDATES (mặc định 1000). ' +
        'Output: { total, facets: { <facet>: [{ value, count }] } }, mỗi facet sắp theo count giảm dần. ' +
        'Record thiếu một facet thì không được đếm ở facet đó.',
      inputSchema: {
        query: z.string().optional().describe('Mô tả tiếng Anh/Việt; bỏ trống để đếm toàn corpus'),
        type: ResourceTypeEnum.optional().describe('Chỉ đếm 1 loại resource (thường "recipe")'),
        filters: filtersSchema.describe(FILTERS_HELP),
        style: z.array(z.string()).optional().describe('Lọc pack style: toon, stylized, retro, sci-fi, low-poly'),
        keywords: z.array(z.string()).optional().describe('Lọc: record có BẤT KỲ keyword nào'),
      },
    },
    async ({ query, type, filters, style, keywords }) => {
      const result = await facets({ query, type, style, keywords, filters: store.parseFilters(filters) });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'vfx_related',
    {
      title: 'Graph neighbourhood of a vfx:// URI',
      description:
        'Hàng xóm của một record trong knowledge graph. rel: ' +
        'variant_of (cùng effect khác màu/version), pairs_with (cùng bộ: muzzle + projectile + impact), ' +
        'similar_to (dùng chung material/texture, kèm weight = Jaccard), applies_to (technique/component/shader/code ↔ recipe áp dụng, hai chiều), ' +
        'uses (dependency vfx://). Bỏ `rel` = mọi loại, sắp theo loại rồi weight. ' +
        'Output: { uri, family, related: [{ uri, name, type, rel, direction: out|in|family, weight, category }] }. ' +
        'Dùng sau vfx_search để lấy đồng bộ/biến thể/effect tương tự của một card.',
      inputSchema: {
        uri: z.string().describe('vd vfx://recipe/retro-arsenal-fire-muzzle-blue/1'),
        rel: z.enum(['variant_of', 'pairs_with', 'similar_to', 'applies_to', 'uses']).optional(),
        limit: z.number().int().min(1).max(100).optional().describe('mặc định 20'),
      },
    },
    async ({ uri, rel, limit }) => {
      const result = await store.related(uri, { rel, limit });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'vfx_resolve',
    {
      title: 'Resolve a vfx:// URI',
      description:
        'Giải mã vfx:// URI -> manifest: metadata, dependencies (vfx:// URI mà record dùng), download_url. ' +
        'Recipe trích từ pack còn có `assets`: material / texture / shader / mesh (guid, path trong pack, pack, license, `external`/`builtin`) — ' +
        'đó là thứ cần kéo từ pack về cùng recipe; chỉ metadata, KHÔNG có bytes. ' +
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

  server.registerTool(
    'vfx_recolor',
    {
      title: 'Recolor a VFX recipe',
      description:
        'Đổi màu một recipe bằng phép biến đổi xác định (KHÔNG cần fetch bản màu khác): xoay hue trong OKLCh mọi màu trong params ' +
        '(startColor, colorOverLifetime, trail, line...) rồi trả `payload` mới + `tint` (material cần nhuộm trên BẢN SAO: {materialGuid, property, from, to}) + `changes` (từng key: path, from, to). ' +
        'Chỉ dùng khi card có `recolorable: true` (họ biến thể đã kiểm chứng: recolor base ≈ bản màu thật, dE≤10); ' +
        'nếu false (`recolorReason`: texture = màu nằm trong ảnh, params, no-keys...) thì fetch bản biến thể thật. ' +
        'Cho `targetColor` (hex #rrggbb — màu đích) HOẶC `hueShiftDeg` (-360..360, +90 = lục → lam; đỏ ≈ 0/360), không cả hai. ' +
        '`preserveLuminance` (mặc định true) giữ độ sáng từng màu. ' +
        '`publish:true` tạo record MỚI derived_from record gốc (license kế thừa, visibility=project, slug <gốc>-recolor-<hex>), idempotent: cùng đầu vào trả lại record cũ (`published.created:false`). ' +
        'Record gốc không bị sửa. `includePayload:false` bỏ payload khỏi output (dùng với publish rồi vfx_fetch).',
      inputSchema: {
        uri: z.string().describe('vd vfx://recipe/retro-arsenal-fire-muzzle-blue/1'),
        targetColor: z.string().optional().describe('Hex #rrggbb — màu mọi key sẽ dịch tới'),
        hueShiftDeg: z.number().min(-360).max(360).optional().describe('Góc xoay hue, độ; dùng khi không có targetColor'),
        preserveLuminance: z.boolean().optional().describe('mặc định true'),
        publish: z.boolean().optional().describe('true = tạo/tìm record derived_from; mặc định false (chỉ tính)'),
        includePayload: z.boolean().optional().describe('mặc định true'),
      },
    },
    async (args) => {
      const result = await recolorRecord(args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
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
