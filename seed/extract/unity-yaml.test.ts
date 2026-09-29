import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnityDocs, UnityYamlError } from './unity-yaml.ts';

const HEAD = '%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n';

test('parses block maps, same-indent sequences, flow maps and exact big ids', () => {
  const docs = parseUnityDocs(`${HEAD}--- !u!1 &198566116396328362
GameObject:
  m_Component:
  - component: {fileID: 4636345221840368}
  - component: {fileID: 198566116396328362}
  m_Name: Healing
  m_IsActive: 1
  scale: 0.5
`);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].fileId, '198566116396328362'); // > 2^53: must stay exact
  assert.equal(docs[0].type, 'GameObject');
  const comp = docs[0].body.m_Component as Array<{ component: { fileID: unknown } }>;
  assert.equal(comp.length, 2);
  assert.equal(comp[1].component.fileID, '198566116396328362'); // string, not a rounded float
  assert.equal(docs[0].body.m_IsActive, 1);
  assert.equal(docs[0].body.scale, 0.5);
});

test('joins Unity-wrapped multi-line flow maps and keeps guids as strings', () => {
  const docs = parseUnityDocs(`${HEAD}--- !u!198 &5
ParticleSystem:
  m_Mesh: {fileID: -1378344405640733772, guid: 12345678e0123456789012345678901a,
    type: 3}
  m_Rot: {x: -0.000000003871555, y: 0, z: 0.25881913,
    w: 0.9659258}
`);
  const b = docs[0].body as Record<string, Record<string, unknown>>;
  assert.equal(b.m_Mesh.guid, '12345678e0123456789012345678901a'); // numeric-looking guid is NOT a float
  assert.equal(b.m_Mesh.fileID, '-1378344405640733772');
  assert.equal(b.m_Rot.w, 0.9659258);
});

test('sequence items that are mappings keep their sibling keys', () => {
  const docs = parseUnityDocs(`${HEAD}--- !u!21 &1
Material:
  m_TexEnvs:
  - _MainTex:
      m_Texture: {fileID: 2800000, guid: abc, type: 3}
      m_Scale: {x: 1, y: 1}
  - _Other:
      m_Texture: {fileID: 0}
  m_Floats:
  - _Mode: 2
  - _Cutoff: 0.5
`);
  const b = docs[0].body as Record<string, Array<Record<string, unknown>>>;
  assert.equal(b.m_TexEnvs.length, 2);
  assert.deepEqual(Object.keys(b.m_TexEnvs[0]), ['_MainTex']);
  assert.equal(b.m_Floats[1]._Cutoff, 0.5);
});

test('stripped docs and quoted scalars', () => {
  const docs = parseUnityDocs(`${HEAD}--- !u!4 &7 stripped
Transform:
  m_Name: "a: \\"b\\""
  other: 'it''s'
`);
  assert.equal(docs[0].stripped, true);
  assert.equal(docs[0].body.m_Name, 'a: "b"');
  assert.equal(docs[0].body.other, "it's");
});

test('unsupported constructs throw instead of silently degrading', () => {
  assert.throws(() => parseUnityDocs(`${HEAD}--- !u!1 &1\nGameObject:\n  m_Name: |\n    x\n`), UnityYamlError);
  assert.throws(() => parseUnityDocs(`${HEAD}--- !u!1 &1\nGameObject:\n  m_A: {fileID: 1\n`), UnityYamlError);
  assert.throws(() => parseUnityDocs(`${HEAD}garbage\n`), UnityYamlError);
});
