import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { pool } from './db.ts';
import { canonicalSlugs } from './graph.ts';
import { previewFor, slugOfUri, type CardPreview } from './previews.ts';
import * as store from './store.ts';

/**
 * Visual review flow: freeze a candidate list into a session, render it as a card grid (GET /review), let the user
 * pick (POST selection), let the agent read the pick back. Works with no previews at all.
 */

const URI_RE = /^vfx:\/\/[a-z]+\/[a-z0-9]+(?:-[a-z0-9]+)*\/\d+$/;
const ROLE_RE = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_URIS = 80;
const MAX_ROLES = 6;
const DEFAULT_LIMIT = 24;
const DEFAULT_PER_ROLE = 6;
const MAX_PER_ROLE = 12;

/** Raw request shape shared by POST /v1/review, GET /review and the vfx_review tool. */
export interface ReviewRequest {
  /** vfx:// URIs (array or comma-separated string). */
  uris?: string[] | string;
  q?: string;
  type?: store.ResourceType;
  filters?: unknown;
  /** Roles (= categories) for a set review, e.g. ["muzzle","projectile","impact"]; a comma string is accepted too. */
  set?: string[] | string;
  /** Card count for a plain q review (default 24, max 50). */
  limit?: number;
  /** Cards per role for a set review (default 6, max 12). */
  per?: number;
}

/** What is persisted in review_session.query. */
export interface StoredQuery {
  uris?: string[];
  q?: string;
  type?: string;
  filters?: Record<string, string[]>;
  set: string[];
  /** uri -> role, frozen at creation. */
  roles: Record<string, string>;
}

const invalid = (m: string): store.VfxError => new store.VfxError(m, 'invalid');

function strList(v: unknown, name: string): string[] {
  const arr = typeof v === 'string' ? v.split(',') : v;
  if (!Array.isArray(arr)) throw invalid(`${name} must be an array or a comma-separated string`);
  return arr.map((x) => {
    if (typeof x !== 'string') throw invalid(`${name} must contain strings`);
    return x.trim();
  }).filter(Boolean);
}

export function parseSet(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === '') return [];
  const roles = [...new Set(strList(raw, 'set'))];
  if (roles.length > MAX_ROLES) throw invalid(`set has at most ${MAX_ROLES} roles`);
  for (const r of roles) if (!ROLE_RE.test(r)) throw invalid(`invalid role "${r}" (a category such as muzzle, projectile, impact)`);
  return roles;
}

export function parseUris(raw: unknown): string[] {
  const uris = [...new Set(strList(raw, 'uris'))];
  if (!uris.length) throw invalid('uris is empty');
  if (uris.length > MAX_URIS) throw invalid(`at most ${MAX_URIS} uris per review`);
  const bad = uris.filter((u) => !URI_RE.test(u));
  if (bad.length) throw invalid(`not a vfx:// URI: ${bad.slice(0, 3).join(', ')}`);
  return uris;
}

const firstCategory = (c: store.Card): string => c.facets.category?.[0] ?? '';

/** Role of a card in a review: the first requested role among its categories, else its first category. */
function roleOf(c: store.Card, set: string[]): string {
  const cats = c.facets.category ?? [];
  return set.find((r) => cats.includes(r)) ?? firstCategory(c);
}

/** Resolve a request into the frozen candidate list (URIs validated to exist) + roles. */
async function resolve(req: ReviewRequest): Promise<StoredQuery> {
  const set = parseSet(req.set);
  const filters = store.parseFilters(req.filters);
  const type = req.type ?? 'recipe';
  if (req.uris !== undefined && req.uris !== null && (Array.isArray(req.uris) ? req.uris.length : req.uris !== '')) {
    const uris = parseUris(req.uris);
    const cards = await store.cardsByUris(uris); // throws not_found listing every missing URI
    const roles: Record<string, string> = {};
    for (const c of cards) roles[c.uri] = roleOf(c, set);
    return { uris, set, roles };
  }
  const q = (req.q ?? '').trim();
  if (!q) throw invalid('uris or q is required');
  const roles: Record<string, string> = {};
  const uris: string[] = [];
  if (set.length) {
    const per = Math.min(Math.max(Math.floor(req.per ?? DEFAULT_PER_ROLE), 1), MAX_PER_ROLE);
    const lanes = await Promise.all(set.map((role) => store.search({ query: q, type, filters: { ...filters, category: [role] }, limit: per })));
    set.forEach((role, i) => {
      for (const c of lanes[i]) {
        if (uris.includes(c.uri)) continue; // an effect that is both explosion and muzzle keeps its first role
        uris.push(c.uri);
        roles[c.uri] = role;
      }
    });
  } else {
    const limit = Math.min(Math.max(Math.floor(req.limit ?? DEFAULT_LIMIT), 1), 50);
    for (const c of await store.search({ query: q, type, filters, limit })) {
      uris.push(c.uri);
      roles[c.uri] = firstCategory(c);
    }
  }
  if (!uris.length) throw new store.VfxError(`no candidates for "${q}"${set.length ? ` in ${set.join(', ')}` : ''}`, 'not_found');
  return { q, type, filters: filters as Record<string, string[]>, set, uris, roles };
}

/* ---------------------------------------------------------------- sessions */

export function reviewUrl(session: string): string {
  return `${config.publicBaseUrl || `http://localhost:${config.port}`}/review?session=${session}`;
}

export async function createSession(req: ReviewRequest): Promise<{ session: string; url: string; count: number }> {
  const query = await resolve(req);
  const id = randomUUID();
  await pool.query('INSERT INTO review_session (id, query, uris) VALUES ($1, $2::jsonb, $3::jsonb)', [id, JSON.stringify(query), JSON.stringify(query.uris ?? Object.keys(query.roles))]);
  return { session: id, url: reviewUrl(id), count: (query.uris ?? []).length };
}

interface SessionRow {
  id: string;
  created_at: string;
  query: StoredQuery;
  uris: string[];
}

async function getSession(id: string): Promise<SessionRow> {
  if (!/^[0-9a-f-]{36}$/.test(id ?? '')) throw invalid('session must be a review session id');
  const r = await pool.query<SessionRow>('SELECT id, created_at, query, uris FROM review_session WHERE id = $1', [id]);
  if (!r.rowCount) throw new store.VfxError(`Review session not found: ${id}`, 'not_found');
  return r.rows[0];
}

export interface SelectionItem {
  uri: string;
  role: string;
  chosen_at: string;
}

async function selectionOf(id: string): Promise<SelectionItem[]> {
  const r = await pool.query<SelectionItem>('SELECT uri, role, chosen_at FROM review_selection WHERE session_id = $1 ORDER BY chosen_at, uri', [id]);
  return r.rows;
}

/** Replace the session's selection with `uris` (subset of the session's candidates). Roles default to the frozen ones. */
export async function saveSelection(input: { session?: string; uris?: unknown; roles?: unknown }): Promise<{ session: string; count: number; selection: SelectionItem[] }> {
  const s = await getSession(input.session ?? '');
  const uris = input.uris === undefined ? [] : [...new Set(strList(input.uris, 'uris'))];
  const known = new Set(s.uris);
  const foreign = uris.filter((u) => !known.has(u));
  if (foreign.length) throw invalid(`not in this review session: ${foreign.slice(0, 3).join(', ')}`);
  let given: Record<string, string> = {};
  if (input.roles !== undefined && input.roles !== null) {
    if (typeof input.roles !== 'object' || Array.isArray(input.roles)) throw invalid('roles must be an object {uri: role}');
    given = input.roles as Record<string, string>;
    for (const [u, r] of Object.entries(given)) {
      if (!known.has(u)) throw invalid(`roles: not in this review session: ${u}`);
      if (typeof r !== 'string' || (r !== '' && !ROLE_RE.test(r))) throw invalid(`roles: invalid role for ${u}`);
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM review_selection WHERE session_id = $1', [s.id]);
    for (const uri of uris) {
      await client.query('INSERT INTO review_selection (session_id, uri, role) VALUES ($1, $2, $3)', [s.id, uri, given[uri] ?? s.query.roles?.[uri] ?? '']);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  const selection = await selectionOf(s.id);
  return { session: s.id, count: selection.length, selection };
}

export async function getSelection(id: string): Promise<{ session: string; created_at: string; query: StoredQuery; uris: string[]; selection: SelectionItem[] }> {
  const s = await getSession(id);
  return { session: s.id, created_at: s.created_at, query: s.query, uris: s.uris, selection: await selectionOf(s.id) };
}

export async function deleteSession(id: string): Promise<void> {
  await pool.query('DELETE FROM review_session WHERE id = $1', [id]);
}

/* ------------------------------------------------------------------ layout */

export interface Placed<T> {
  item: T;
  col: number;
  row: number;
}

interface Pairable {
  uri: string;
  role: string;
  pairsWith: Array<{ uri: string }>;
  variants: Array<{ uri: string }>;
}

const uriSet = (c: Pairable): Set<string> => new Set([c.uri, ...c.variants.map((v) => v.uri)]);
const pairedWith = (a: Pairable, b: Pairable): boolean => {
  const bs = uriSet(b);
  const as = uriSet(a);
  return a.pairsWith.some((p) => bs.has(p.uri)) || b.pairsWith.some((p) => as.has(p.uri));
};

/**
 * Column per role (in `roles` order), a row per matching set: the first role is the anchor, and in every other
 * role the card paired with the anchor card (pairs_with either way, variants included) is put on its row. Unmatched
 * cards fill the remaining empty cells in their own order, then spill into extra rows. Rows/cols are 0-based.
 */
export function layoutSet<T extends Pairable>(cards: T[], roles: string[]): Array<Placed<T>> {
  const lanes = roles.map((r) => cards.filter((c) => c.role === r));
  const grid: Array<Array<T | null>> = lanes[0]?.map((a) => [a, ...roles.slice(1).map(() => null)]) ?? [];
  const used = new Set<T>();
  lanes.slice(1).forEach((lane, li) => {
    const col = li + 1;
    grid.forEach((row) => {
      const anchor = row[0];
      const hit = anchor && lane.find((c) => !used.has(c) && pairedWith(anchor, c));
      if (hit) {
        row[col] = hit;
        used.add(hit);
      }
    });
    for (const c of lane) {
      if (used.has(c)) continue;
      let row = grid.find((r) => r[col] === null && r[0] !== null);
      if (!row) {
        row = roles.map(() => null);
        grid.push(row);
      }
      row[col] = c;
      used.add(c);
    }
  });
  const out: Array<Placed<T>> = [];
  grid.forEach((row, ri) => row.forEach((c, ci) => c && out.push({ item: c, col: ci, row: ri })));
  return out;
}

/* ------------------------------------------------------------------- render */

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const CHIP_HEX: Record<string, string> = {
  red: '#e5484d', orange: '#f76b15', yellow: '#f5d90a', green: '#30a46c', cyan: '#00b8d9', blue: '#3e63dd',
  purple: '#8e4ec6', pink: '#e93d82', white: '#f8f8f8', black: '#111111', grey: '#8b8d98', gold: '#d4a017',
};

interface RenderCard extends store.Card {
  role: string;
  preview: CardPreview | null;
}

const TEMPLATE = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'review.html'), 'utf8');

function mediaHtml(p: CardPreview | null): string {
  if (!p) return '<div class="noprev">chưa có preview</div>';
  const note = p.viaFamily ? '<span class="famnote" title="Chưa có preview riêng: dùng bản gốc của họ biến thể">bản gốc họ</span>' : '';
  if (p.video) {
    return `<video muted loop playsinline preload="none" data-src="${esc(p.video)}"${p.poster ? ` poster="${esc(p.poster)}"` : ''}></video>${note}`;
  }
  return `<img loading="lazy" src="${esc(p.poster ?? '')}" alt="">${note}`;
}

function cardHtml(c: RenderCard, i: number, place: { col: number; row: number } | null, picked: boolean, onPage: Map<string, number>): string {
  const facts = [c.facets.playback, c.facets.duration, c.facets.scale, c.facets.cost ? `cost ${c.facets.cost}` : ''].filter(Boolean).join(' · ');
  const colors = [...new Set(c.variants.flatMap((v) => v.colors))];
  const chips = colors.map((n) => (CHIP_HEX[n] ? `<span class="chip" style="background:${CHIP_HEX[n]}" title="${esc(n)}"></span>` : `<span class="chip txt">${esc(n)}</span>`)).join('');
  const recolor = c.recolorable === true ? '<span class="badge">có thể đổi màu</span>' : '';
  const pairs = c.pairsWith
    .map((p) => {
      const idx = onPage.get(p.uri);
      const href = idx !== undefined ? `#c${idx}` : `/review?uris=${encodeURIComponent(p.uri)}`;
      return `<a href="${esc(href)}"${idx === undefined ? ' target="_blank" rel="noopener"' : ''}>${esc(p.category ? `${p.category}: ` : '')}${esc(p.name)}</a>`;
    })
    .join('');
  const behavior = c.behavior ? esc(c.behavior) : `<i>${esc(c.description)} (mô tả, chưa có behavior)</i>`;
  const pos = place ? ` style="--c:${place.col + 1};--r:${place.row + 2}"` : '';
  return (
    `<article class="card${picked ? ' picked' : ''}" id="c${i}" data-uri="${esc(c.uri)}" data-role="${esc(c.role)}"${pos}>` +
    `<div class="media">${mediaHtml(c.preview)}</div>` +
    `<div class="body"><h3>${esc(c.name)}</h3>` +
    `<div class="sub">${esc([c.pack, c.style.join(' / ')].filter(Boolean).join(' · '))}</div>` +
    `<p class="behavior">${behavior}</p>` +
    (facts ? `<div class="facts">${esc(facts)}</div>` : '') +
    (chips || recolor ? `<div class="chips">${chips}${recolor}</div>` : '') +
    (pairs ? `<div class="pairs"><span>Cùng bộ:</span>${pairs}</div>` : '') +
    `<button type="button" class="pick" aria-pressed="${picked}">${picked ? 'Đã chọn' : 'Chọn'}</button></div></article>`
  );
}

/** Whole /review page for a stored session. */
export async function renderPage(sessionId: string): Promise<string> {
  const s = await getSession(sessionId);
  const [cards, canon, chosen] = await Promise.all([store.cardsByUris(s.uris), canonicalSlugs(s.uris), selectionOf(s.id)]);
  const roles = s.query.roles ?? {};
  const rc: RenderCard[] = cards.map((c) => ({
    ...c,
    role: roles[c.uri] ?? firstCategory(c),
    preview: (() => {
      const slug = slugOfUri(c.uri);
      return slug ? previewFor(slug, canon.get(c.uri)) : null;
    })(),
  }));
  const picked = new Set(chosen.map((x) => x.uri));
  let set = s.query.set ?? [];
  if (set.length) {
    // uris + set: a card whose category is none of the requested roles still needs a column.
    const strays = rc.filter((c) => !set.includes(c.role));
    for (const c of strays) c.role = 'other';
    if (strays.length) set = [...set, 'other'];
  }
  const onPage = new Map(rc.map((c, i) => [c.uri, i]));
  const idx = new Map(rc.map((c, i) => [c, i]));

  let body: string;
  let cols = 1;
  if (set.length) {
    cols = set.length;
    const placed = layoutSet(rc, set);
    const byRole = set.map((r) => placed.filter((p) => p.item.role === r));
    body = set
      .map((r, ci) => {
        const heads = `<h2 class="role" style="--c:${ci + 1}">${esc(r)} <small>${byRole[ci].length}</small></h2>`;
        return `<section class="rolecol" data-role="${esc(r)}" aria-label="${esc(r)}">${heads}${byRole[ci].map((p) => cardHtml(p.item, idx.get(p.item)!, p, picked.has(p.item.uri), onPage)).join('')}</section>`;
      })
      .join('');
  } else {
    body = `<section class="flat">${rc.map((c, i) => cardHtml(c, i, null, picked.has(c.uri), onPage)).join('')}</section>`;
  }

  const previewCount = rc.filter((c) => c.preview).length;
  const title = s.query.q ? `Review: ${s.query.q}${set.length ? ` (${set.join(', ')})` : ''}` : 'Review: danh sách chọn tay';
  const slots: Record<string, string> = {
    TITLE: esc(title),
    SESSION: esc(s.id),
    COLS: String(cols),
    EXCLUSIVE: set.length ? '1' : '0',
    COUNT: String(rc.length),
    PREVIEWS: String(previewCount),
    BODY: body,
  };
  // One pass, so a slot value (a query containing "__BODY__") is never re-expanded.
  return TEMPLATE.replace(/__(TITLE|SESSION|COLS|EXCLUSIVE|COUNT|PREVIEWS|BODY)__/g, (_m, k: string) => slots[k]);
}
