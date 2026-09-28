-- Mở rộng type: thêm technique + skill (brainstorm chia 5 loại knowledge).
ALTER TABLE resource DROP CONSTRAINT IF EXISTS resource_type_check;
ALTER TABLE resource ADD CONSTRAINT resource_type_check CHECK (type IN
  ('texture','shader','code','recipe','component','vfx','technique','skill'));

CREATE INDEX IF NOT EXISTS resource_edge_dst_idx ON resource_edge (dst, rel);
