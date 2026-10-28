import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AUTH_DISABLED = '1';
const { pool, migrate } = await import('./db.ts');
const { buildHttp } = await import('./http.ts');
const { GIF_LADDER, GIF_MAX_BYTES, encodeGif, gifFacts, ingestPreviews } = await import('./preview-gif-encode.ts');
const { gifBySlug } = await import('./preview-gif.ts');
const store = await import('./store.ts');
const review = await import('./review.ts');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vfx-gif-test-'));
const SLUGS = ['zz-gif-test-a', 'zz-gif-test-b', 'zz-gif-test-c'];
const sessions: string[] = [];
const cleanupSlugs: string[] = [...SLUGS];

after(async () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const s of sessions) await pool.query('DELETE FROM review_session WHERE id = $1', [s]).catch(() => undefined);
  await pool.query('DELETE FROM preview_gif WHERE slug = ANY($1::text[])', [cleanupSlugs]).catch(() => undefined);
  await pool.end().catch(() => undefined);
});

/** A small real VP9 webm (the lane's format): `seed` changes the picture so two sources hash differently. */
function makeWebm(file: string, seed: number, seconds = 1): void {
  const r = spawnSync(
    'ffmpeg',
    ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=256x256:rate=24:duration=${seconds}`, '-vf', `hue=h=${seed * 40}`, '-c:v', 'libvpx-vp9', '-b:v', '200k', file],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
}

function writeIndex(dir: string, slugs: string[]): void {
  const items = Object.fromEntries(slugs.map((s) => [s, { webm: `${s}.webm`, poster: `${s}.webp`, fps: 24, frames: 24, size: 256 }]));
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ version: 1, items }));
}

async function api(method: 'GET' | 'HEAD' | 'POST', url: string, opts: { payload?: unknown; headers?: Record<string, string> } = {}) {
  const app = await buildHttp();
  const res = await app.inject({ method, url, payload: opts.payload as object | undefined, headers: opts.headers });
  await app.close();
  return res;
}

test('migration 009 creates preview_gif with its constraints', async () => {
  await migrate();
  const cols = await pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'preview_gif' ORDER BY ordinal_position`);
  assert.deepEqual(cols.rows.map((c) => c.column_name), ['slug', 'gif', 'width', 'height', 'frames', 'fps', 'bytes', 'sha256', 'source_sha256', 'builder', 'encoder', 'created_at', 'updated_at']);
  const applied = await pool.query(`SELECT 1 FROM schema_migrations WHERE name = '009_preview_gif.sql'`);
  assert.equal(applied.rowCount, 1);
  const ins = (slug: string, bytes: number) =>
    pool.query(`INSERT INTO preview_gif (slug, gif, width, height, frames, fps, bytes, sha256, source_sha256, builder, encoder) VALUES ($1, '\\x474946'::bytea, 1, 1, 1, 1, $2, 'h', 's', 'v1', 'e')`, [slug, bytes]);
  await assert.rejects(ins('Bad Slug', 3), /check constraint/);
  await assert.rejects(ins('zz-gif-test-a', 99), /check constraint/); // bytes must equal octet_length(gif)
  await ins('zz-gif-test-a', 3);
  await assert.rejects(ins('zz-gif-test-a', 3), /duplicate key/); // one row per slug
  await pool.query(`DELETE FROM preview_gif WHERE slug = 'zz-gif-test-a'`);
});

test('encodeGif: a valid looping GIF within budget, facts read back match ffprobe', async () => {
  const webm = path.join(tmp, 'enc.webm');
  makeWebm(webm, 1, 1);
  const enc = await encodeGif(webm);
  assert.equal(enc.overBudget, false);
  assert.ok(enc.buffer.length <= GIF_MAX_BYTES);
  assert.deepEqual(enc.rung, GIF_LADDER[0]);
  assert.equal(enc.buffer.toString('ascii', 0, 6), 'GIF89a');
  assert.ok(enc.buffer.includes(Buffer.from('NETSCAPE2.0')), 'loop extension present (loops forever)');
  const facts = gifFacts(enc.buffer);
  assert.equal(facts.width, 192);
  assert.equal(facts.height, 192);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames,width', '-of', 'csv=p=0', '-f', 'gif', '-i', 'pipe:0'], { input: enc.buffer, encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(probe.stdout.trim().split(',').map(Number).sort((x, y) => x - y), [facts.frames, 192].sort((x, y) => x - y));
  assert.equal(facts.frames, 12); // 1 s at the rung's 12 fps
  assert.throws(() => gifFacts(Buffer.from('not a gif at all')), /not a GIF/);
});

test('encodeGif: steps down the ladder when over the cap, flags overBudget when nothing fits', async () => {
  const webm = path.join(tmp, 'ladder.webm');
  makeWebm(webm, 2, 2);
  const top = await encodeGif(webm);
  const stepped = await encodeGif(webm, { maxBytes: top.buffer.length - 1 });
  assert.ok(GIF_LADDER.findIndex((r) => r.size === stepped.rung.size) > 0, 'a smaller rung than the first');
  assert.ok(stepped.buffer.length < top.buffer.length);
  const none = await encodeGif(webm, { maxBytes: 1 });
  assert.equal(none.overBudget, true);
  assert.deepEqual(none.rung, GIF_LADDER[GIF_LADDER.length - 1]); // smallest wins
  await assert.rejects(encodeGif(path.join(tmp, 'missing.webm')), /ffmpeg exit/);
});

test('ingestPreviews: stores, is idempotent by content hash, re-encodes on a new render or builder, skips what is missing', async () => {
  const dir = path.join(tmp, 'previews');
  fs.mkdirSync(dir);
  const [a, b, c] = SLUGS;
  makeWebm(path.join(dir, `${a}.webm`), 1);
  makeWebm(path.join(dir, `${b}.webm`), 2);
  writeIndex(dir, [a, b, c]); // c is listed but has no webm
  const only = SLUGS;

  const first = await ingestPreviews({ dir, only });
  assert.equal(first.stored, 2);
  assert.equal(first.skipped, 1);
  assert.equal(first.failed, 0);
  assert.match(first.results.find((r) => r.slug === c)!.reason!, /missing/);
  const rowA = await gifBySlug(a);
  assert.ok(rowA);
  assert.equal(rowA.bytes, rowA.gif.length);
  assert.equal(rowA.width, 192);
  assert.equal(rowA.fps, 12);
  assert.equal(rowA.builder, 'v1');
  assert.equal(rowA.encoder, '192px@12fps/96c');

  // same webm, same builder -> nothing written (row untouched, byte for byte and timestamp for timestamp)
  const second = await ingestPreviews({ dir, only });
  assert.equal(second.stored, 0);
  assert.equal(second.unchanged, 2);
  const rowA2 = await gifBySlug(a);
  assert.equal(rowA2!.sha256, rowA.sha256);
  assert.equal(rowA2!.updatedAt.getTime(), rowA.updatedAt.getTime());

  // a re-render of b only: b is re-encoded, a is left alone
  makeWebm(path.join(dir, `${b}.webm`), 5);
  const before = await gifBySlug(b);
  const third = await ingestPreviews({ dir, only });
  assert.deepEqual(third.results.filter((r) => r.status === 'stored').map((r) => r.slug), [b]);
  assert.notEqual((await gifBySlug(b))!.sha256, before!.sha256);
  assert.equal((await gifBySlug(a))!.updatedAt.getTime(), rowA.updatedAt.getTime());

  // a new encoder generation re-encodes everything; --force does too
  assert.equal((await ingestPreviews({ dir, only, builder: 'v2' })).stored, 2);
  assert.equal((await gifBySlug(a))!.builder, 'v2');
  assert.equal((await ingestPreviews({ dir, only, builder: 'v2' })).unchanged, 2);
  assert.equal((await ingestPreviews({ dir, only, builder: 'v2', force: true })).stored, 2);

  // `only` limits the run; one corrupt webm fails alone
  fs.writeFileSync(path.join(dir, `${a}.webm`), 'this is not a video');
  const mixed = await ingestPreviews({ dir, only, builder: 'v2' });
  assert.equal(mixed.failed, 1);
  assert.equal(mixed.results.find((r) => r.slug === a)!.status, 'failed');
  assert.equal(mixed.unchanged, 1);
  assert.equal((await ingestPreviews({ dir, only: [b], builder: 'v2' })).scanned, 1);

  // no index, no error
  const empty = path.join(tmp, 'empty');
  fs.mkdirSync(empty);
  assert.equal((await ingestPreviews({ dir: empty })).scanned, 0);
});

test('GET /previews/<slug>.gif: 200 image/gif from the DB, ETag + 304, HEAD, 404s', async () => {
  const row = await gifBySlug(SLUGS[1]);
  assert.ok(row, 'previous test stored it');
  const res = await api('GET', `/previews/${SLUGS[1]}.gif`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/gif');
  assert.equal(res.headers['content-length'], String(row.bytes));
  assert.equal(res.headers.etag, `"${row.sha256}"`);
  assert.match(String(res.headers['cache-control']), /max-age=\d+/);
  assert.ok(!/immutable/.test(String(res.headers['cache-control'])), 'URL is not content-addressed, so it must revalidate');
  assert.ok(res.rawPayload.equals(row.gif));
  assert.equal(res.rawPayload.toString('ascii', 0, 3), 'GIF');

  const cached = await api('GET', `/previews/${SLUGS[1]}.gif`, { headers: { 'if-none-match': String(res.headers.etag) } });
  assert.equal(cached.statusCode, 304);
  assert.equal((await api('GET', `/previews/${SLUGS[1]}.gif`, { headers: { 'if-none-match': '"stale"' } })).statusCode, 200);

  const head = await api('HEAD', `/previews/${SLUGS[1]}.gif`);
  assert.equal(head.statusCode, 200);
  assert.equal(head.headers['content-type'], 'image/gif');

  for (const bad of ['zz-no-such-effect.gif', '..%2Fx.gif', 'UPPER.gif', 'a..gif', '.gif']) {
    assert.equal((await api('GET', `/previews/${bad}`)).statusCode, 404, bad);
  }
  assert.equal((await api('GET', '/previews/index.json')).statusCode, 404); // disk grammar is unchanged
});

/** Two recipe records (a, b) neither of which has a GIF row; b is a variant of a's family when `family` is true. */
async function recipesWithoutGif(): Promise<string[]> {
  const r = await pool.query<{ uri: string; slug: string }>(
    `SELECT r.uri, r.slug FROM resource r LEFT JOIN preview_gif g ON g.slug = r.slug
      WHERE r.type = 'recipe' AND g.slug IS NULL ORDER BY r.slug LIMIT 2`,
  );
  assert.equal(r.rowCount, 2, 'need two recipes without a GIF');
  return r.rows.map((x) => x.uri);
}

async function putGif(slug: string, from: string): Promise<void> {
  const src = (await gifBySlug(from))!;
  await pool.query(
    `INSERT INTO preview_gif (slug, gif, width, height, frames, fps, bytes, sha256, source_sha256, builder, encoder)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'x', 'v1', $9) ON CONFLICT (slug) DO NOTHING`,
    [slug, src.gif, src.width, src.height, src.frames, src.fps, src.bytes, src.sha256, src.encoder],
  );
  cleanupSlugs.push(slug);
}

test('cards expose gif (and preview_uri) when the slug has one, null otherwise', async () => {
  const [withGif, without] = await recipesWithoutGif();
  const slug = withGif.split('/')[3];
  await putGif(slug, SLUGS[1]);
  const [c1, c2] = await store.cardsByUris([withGif, without]);
  assert.equal(c1.gif!.url, `http://127.0.0.1:${process.env.PORT ?? 8787}/previews/${slug}.gif`);
  assert.equal(c1.gif!.path, `/previews/${slug}.gif`);
  assert.equal(c1.gif!.viaFamily, false);
  assert.deepEqual([c1.gif!.width, c1.gif!.height, c1.gif!.fps], [192, 192, 12]);
  assert.equal(c1.preview_uri, c1.gif!.url);
  assert.equal(c2.gif, null);
  assert.equal(c2.preview_uri, null);

  const found = await store.search({ query: c1.name, type: 'recipe', limit: 50, collapseVariants: false });
  const hit = found.find((c) => c.uri === withGif);
  assert.ok(hit, 'the record is found by its own name');
  assert.equal(hit.gif!.path, `/previews/${slug}.gif`);
});

test('a variant without its own GIF borrows its family canonical one, flagged viaFamily', async () => {
  const fam = await pool.query<{ uri: string; canon: string }>(
    `SELECT r.uri, (SELECT c.slug FROM resource c WHERE c.meta->>'family' = r.meta->>'family' ORDER BY c.slug, c.version LIMIT 1) AS canon
       FROM resource r
      WHERE r.type = 'recipe' AND r.meta->>'family' IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM preview_gif g WHERE g.slug IN (SELECT c.slug FROM resource c WHERE c.meta->>'family' = r.meta->>'family'))
        AND r.slug <> (SELECT c.slug FROM resource c WHERE c.meta->>'family' = r.meta->>'family' ORDER BY c.slug, c.version LIMIT 1)
      LIMIT 1`,
  );
  assert.equal(fam.rowCount, 1, 'need a variant family with no GIF yet');
  const { uri, canon } = fam.rows[0];
  await putGif(canon, SLUGS[1]);
  const [card] = await store.cardsByUris([uri]);
  assert.equal(card.gif!.viaFamily, true);
  assert.equal(card.gif!.path, `/previews/${canon}.gif`);
});

test('the review page (flat and set) embeds the DB GIF as an <img> and counts it as a preview', async () => {
  const [a, b] = await recipesWithoutGif();
  const slugA = a.split('/')[3];
  await putGif(slugA, SLUGS[1]);

  const flat = await api('GET', `/review?uris=${encodeURIComponent(`${a},${b}`)}`);
  assert.equal(flat.statusCode, 200);
  const sidFlat = /data-session="([0-9a-f-]{36})"/.exec(flat.body)![1];
  sessions.push(sidFlat);
  assert.match(flat.body, new RegExp(`<img class="gif" loading="lazy" src="/previews/${slugA}\\.gif" width="192" height="192"`));
  const shown = (flat.body.match(/<img class="gif"/g) ?? []).length;
  assert.ok(shown >= 1 && shown <= 2);
  assert.match(flat.body, new RegExp(`${shown} có preview`)); // the header counts a DB GIF as a preview

  const created = await review.createSession({ uris: [a, b], set: ['impact', 'aura'] });
  sessions.push(created.session);
  const setPage = await api('GET', `/review?session=${created.session}`);
  assert.equal(setPage.statusCode, 200);
  assert.match(setPage.body, /data-exclusive="1"/);
  assert.match(setPage.body, new RegExp(`src="/previews/${slugA}\\.gif"`));
});
