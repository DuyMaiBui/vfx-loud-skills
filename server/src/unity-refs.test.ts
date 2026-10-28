import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BUILTIN_NAMES,
  builtinName,
  classifyGuid,
  isBuiltinGuid,
  loadPackageGuids,
  PACKAGE_GUID_MAP_PATH,
  scanRefs,
} from './unity-refs.ts';

const SELF = '1234567890abcdef1234567890abcdef';
const MAT = '5e6f70819a2b3c4d5e6f708192031425';
const SCRIPT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TEX = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ASMDEF_REF = 'cccccccccccccccccccccccccccccccc';
const SUBGRAPH = 'dddddddddddddddddddddddddddddddd';
const URP_PARTICLES_UNLIT = '0406db5a14f94604a8c57ccfbc9f3b46';

// A trimmed real-shaped prefab: a self-reference (m_CorrespondingSourceObject carrying its own guid),
// a fileID-only reference (no guid, must be ignored), and two guid references.
const PREFAB_YAML = [
  '%YAML 1.1',
  '%TAG !u! tag:unity3d.com,2011:',
  '--- !u!1 &100',
  'GameObject:',
  '  m_Component:',
  '  - component: {fileID: 400}',
  '  m_CorrespondingSourceObject: {fileID: 100100000, guid: ' + SELF + ', type: 3}',
  '--- !u!23 &400',
  'MeshRenderer:',
  '  m_Materials:',
  '  - {fileID: 2100000, guid: ' + MAT + ', type: 2}',
  '  m_Script: {fileID: 11500000, guid: ' + SCRIPT + ', type: 3}',
  '  m_Other: {fileID: 10300000}',
  '',
].join('\n');

test('P1: YAML guid references in a prefab; fileID-only references are not refs', () => {
  const refs = scanRefs(PREFAB_YAML, SELF);
  assert.deepEqual(refs.sort(), [MAT, SCRIPT].sort());
});

test('own guid is excluded: the real self-reference (BalloonRelease m_CorrespondingSourceObject) is not a dependency', () => {
  assert.equal(scanRefs(PREFAB_YAML).includes(SELF), true, 'without the own guid, the self-reference is visible');
  assert.equal(scanRefs(PREFAB_YAML, SELF).includes(SELF), false, 'with the own guid, it is excluded');
});

test('P2: asmdef references by GUID:<hex>', () => {
  const asmdef = `{"name":"Fx","references":["GUID:${ASMDEF_REF}","Unity.TextMeshPro"]}`;
  assert.deepEqual(scanRefs(asmdef), [ASMDEF_REF]);
});

test('P3: Shader Graph escaped-JSON references (m_SerializedTexture, m_SerializedSubGraph)', () => {
  // Trimmed shape of a .shadergraph: the graph body is a JSON string, so its references are escaped.
  const graph = String.raw`{"m_SerializedTexture": "{\"guid\":\"${TEX}\",\"type\":3}", "m_SerializedSubGraph": "{\"m_SubGraph\":{\"guid\":\"${SUBGRAPH}\"}}"}`;
  const refs = scanRefs(graph);
  assert.ok(refs.includes(TEX), 'm_SerializedTexture reference found');
  assert.ok(refs.includes(SUBGRAPH), 'm_SerializedSubGraph reference found');
});

test('a plain JSON "guid" key (no escaping) is also a P3 reference', () => {
  assert.deepEqual(scanRefs(`{"guid": "${TEX}"}`), [TEX]);
});

test('distinct and lower-case: a repeated guid appears once', () => {
  assert.deepEqual(scanRefs(`${PREFAB_YAML}\n  guid: ${MAT}\n`, SELF), [MAT, SCRIPT]);
});

test('binary input yields no refs (textures, meshes, audio)', () => {
  const bin = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]), Buffer.from(`guid: ${MAT}`)]);
  assert.deepEqual(scanRefs(bin), []);
});

test('builtin pattern: the Unity default and extra resources are builtin, named as contracted', () => {
  const dflt = '0000000000000000f000000000000000';
  const extra = '0000000000000000e000000000000000';
  assert.equal(isBuiltinGuid(dflt), true);
  assert.equal(isBuiltinGuid(extra), true);
  assert.equal(isBuiltinGuid(MAT), false);
  assert.equal(builtinName(dflt), BUILTIN_NAMES.default);
  assert.equal(builtinName(extra), BUILTIN_NAMES.extra);
});

test('classifyGuid: builtin, package from the map, and unresolved for anything else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfx-pkgmap-'));
  const file = path.join(dir, 'map.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      entries: {
        [URP_PARTICLES_UNLIT]: { kind: 'package', name: 'Particles/Unlit', package: 'com.unity.render-pipelines.universal', version: null },
      },
    }),
  );
  try {
    const map = loadPackageGuids(file);
    assert.deepEqual(classifyGuid('0000000000000000f000000000000000', map), {
      kind: 'builtin', name: BUILTIN_NAMES.default, package: null, version: null,
    });
    assert.deepEqual(classifyGuid(URP_PARTICLES_UNLIT, map), {
      kind: 'package', name: 'Particles/Unlit', package: 'com.unity.render-pipelines.universal', version: null,
    });
    assert.deepEqual(classifyGuid(TEX, map), { kind: 'unresolved' }, 'a guid in neither the builtin pattern nor the map is never a nameless requires');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the committed package map is a valid empty skeleton (lane P fills it later)', () => {
  assert.equal(loadPackageGuids(PACKAGE_GUID_MAP_PATH).size, 0);
});

test('loadPackageGuids refuses a malformed map: package entry without a package name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfx-pkgmap-bad-'));
  const file = path.join(dir, 'map.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, entries: { [TEX]: { kind: 'package', name: 'x', package: null, version: null } } }));
  try {
    assert.throws(() => loadPackageGuids(file), /unity-package-guids\.json invalid/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
