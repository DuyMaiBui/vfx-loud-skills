import zlib from 'node:zlib';

/** Test-only builders: a `.unitypackage` (gzip'd tar of <guid>/{asset,asset.meta,pathname}) and Unity YAML fixtures. */

function header(name: string, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148); // checksum placeholder
  h.write('0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

function longNameBlock(name: string): Buffer[] {
  const body = Buffer.from(`${name}\0`, 'utf8');
  const h = header('././@LongLink', body.length);
  h.write('L', 156);
  // recompute checksum with the changed typeflag
  h.write('        ', 148);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return [h, pad(body)];
}

function pad(b: Buffer): Buffer {
  const rem = b.length % 512;
  return rem === 0 ? b : Buffer.concat([b, Buffer.alloc(512 - rem)]);
}

export interface FakeAsset {
  guid: string;
  path: string;
  asset?: Buffer | string;
}

export function makeTarGz(files: Array<{ name: string; data: Buffer | string }>): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    if (Buffer.byteLength(f.name) > 99) parts.push(...longNameBlock(f.name));
    parts.push(header(Buffer.byteLength(f.name) > 99 ? f.name.slice(0, 99) : f.name, data.length), pad(data));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

export function makeUnityPackage(assets: FakeAsset[]): Buffer {
  const files: Array<{ name: string; data: Buffer | string }> = [];
  for (const a of assets) {
    if (a.asset !== undefined) files.push({ name: `${a.guid}/asset`, data: a.asset });
    files.push({ name: `${a.guid}/asset.meta`, data: `fileFormatVersion: 2\nguid: ${a.guid}\n` });
    files.push({ name: `${a.guid}/pathname`, data: `${a.path}\n00\n` });
  }
  return makeTarGz(files);
}

const CURVE = (v: number): string =>
  `{serializedVersion: 2, minMaxState: 0, scalar: ${v}, minScalar: ${v}, maxCurve: {serializedVersion: 2, m_Curve: [{serializedVersion: 3, time: 0, value: 1, inSlope: 0, outSlope: 0, tangentMode: 0, weightedMode: 0, inWeight: 0, outWeight: 0}], m_PreInfinity: 2, m_PostInfinity: 2, m_RotationOrder: 4}, minCurve: {serializedVersion: 2, m_Curve: [], m_PreInfinity: 2, m_PostInfinity: 2, m_RotationOrder: 4}}`;

export interface FixtureOptions {
  name?: string;
  materialGuid?: string;
  withChild?: boolean;
  psCount?: 'one' | 'none';
  instance?: boolean;
  /** With psCount 'none': add a LineRenderer + MonoBehaviour so it is an effect-only prefab. */
  effect?: boolean;
}

/** A tiny but structurally faithful Unity prefab: root PS + optional child PS wired as a sub-emitter. */
export function prefabYaml(o: FixtureOptions = {}): string {
  const name = o.name ?? 'Boom';
  const mat = o.materialGuid ?? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const withChild = o.psCount === 'none' ? false : (o.withChild ?? true);
  const ps = (goId: number, trId: number, psId: number, rdId: number, sub: number | null): string => `--- !u!198 &${psId}
ParticleSystem:
  m_ObjectHideFlags: 0
  m_GameObject: {fileID: ${goId}}
  serializedVersion: 8
  lengthInSec: 2.5
  looping: 0
  prewarm: 0
  moveWithTransform: 1
  InitialModule:
    serializedVersion: 3
    enabled: 1
    startLifetime: ${CURVE(1.5)}
    startSpeed: {serializedVersion: 2, minMaxState: 3, scalar: 8, minScalar: 4, maxCurve: {serializedVersion: 2, m_Curve: [], m_PreInfinity: 2, m_PostInfinity: 2, m_RotationOrder: 4}, minCurve: {serializedVersion: 2, m_Curve: [], m_PreInfinity: 2, m_PostInfinity: 2, m_RotationOrder: 4}}
    startColor:
      serializedVersion: 2
      minMaxState: 0
      minColor: {r: 1, g: 1, b: 1, a: 1}
      maxColor: {r: 1, g: 0.5, b: 0.25, a: 1}
      maxGradient:
        serializedVersion: 2
        key0: {r: 1, g: 1, b: 1, a: 1}
        ctime0: 0
        atime0: 0
        m_Mode: 0
        m_NumColorKeys: 1
        m_NumAlphaKeys: 1
    size3D: 0
    rotation3D: 0
    maxNumParticles: 200
  ShapeModule:
    serializedVersion: 6
    enabled: 1
    type: 4
    angle: 30
    radius:
      value: 1.5
      mode: 0
      spread: 0
  EmissionModule:
    enabled: 1
    rateOverTime: ${CURVE(0)}
    m_BurstCount: 1
    m_Bursts:
    - serializedVersion: 2
      time: 0
      countCurve: ${CURVE(12)}
      cycleCount: 1
      repeatInterval: 0.01
      probability: 1
  ColorModule:
    enabled: 1
    gradient:
      serializedVersion: 2
      minMaxState: 1
      minColor: {r: 1, g: 1, b: 1, a: 1}
      maxColor: {r: 1, g: 1, b: 1, a: 1}
      maxGradient:
        serializedVersion: 2
        key0: {r: 1, g: 0, b: 0, a: 1}
        key1: {r: 0, g: 0, b: 1, a: 1}
        ctime0: 0
        ctime1: 65535
        atime0: 0
        atime1: 65535
        m_Mode: 0
        m_NumColorKeys: 2
        m_NumAlphaKeys: 2
  SizeModule:
    enabled: 0
  UVModule:
    serializedVersion: 2
    enabled: 1
    mode: 0
    tilesX: 4
    tilesY: 4
    sprites:
    - sprite: {fileID: 0}
  NoiseModule:
    enabled: 0
  SubModule:
    serializedVersion: 2
    enabled: ${sub === null ? 0 : 1}
    subEmitters:
    - serializedVersion: 3
      emitter: {fileID: ${sub ?? 0}}
      type: 1
      properties: 0
      emitProbability: 1
--- !u!199 &${rdId}
ParticleSystemRenderer:
  serializedVersion: 6
  m_GameObject: {fileID: ${goId}}
  m_Enabled: 1
  m_Materials:
  - {fileID: 2100000, guid: ${mat}, type: 2}
  m_SortingOrder: 3
  m_RenderMode: 0
  m_SortMode: 1
  m_Mesh: {fileID: 0}
`;
  const go = (id: number, n: string, comps: number[]): string => `--- !u!1 &${id}
GameObject:
  m_ObjectHideFlags: 0
  serializedVersion: 6
  m_Component:
${comps.map((c) => `  - component: {fileID: ${c}}`).join('\n')}
  m_Layer: 0
  m_Name: ${n}
  m_IsActive: 1
`;
  const tr = (id: number, goId: number, father: number, kids: number[], pos: string): string => `--- !u!4 &${id}
Transform:
  m_ObjectHideFlags: 0
  m_GameObject: {fileID: ${goId}}
  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}
  m_LocalPosition: ${pos}
  m_LocalScale: {x: 1, y: 1, z: 1}
  m_Children:${kids.length ? '\n' + kids.map((k) => `  - {fileID: ${k}}`).join('\n') : ' []'}
  m_Father: {fileID: ${father}}
`;
  let out = '%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n';
  if (o.instance) out += '--- !u!1001 &900\nPrefabInstance:\n  m_ObjectHideFlags: 0\n';
  out += go(100, name, o.psCount === 'none' ? (o.effect ? [400, 500, 501] : [400]) : [400, 300, 350]);
  out += tr(400, 100, 0, withChild ? [401] : [], '{x: 0, y: 1, z: 0}');
  if (o.psCount !== 'none') {
    out += ps(100, 400, 300, 350, withChild ? 310 : null);
    if (withChild) {
      out += go(101, 'Sparks', [401, 310, 360]);
      out += tr(401, 101, 400, [], '{x: 0, y: 0, z: 2}');
      out += ps(101, 401, 310, 360, null);
    }
  }
  if (o.effect && o.psCount === 'none') {
    out += `--- !u!120 &500
LineRenderer:
  m_GameObject: {fileID: 100}
  m_Enabled: 1
  m_Materials:
  - {fileID: 2100000, guid: ${mat}, type: 2}
  m_Positions:
  - {x: 0, y: 0, z: 0}
  - {x: 0, y: 0, z: 5}
  m_Parameters:
    serializedVersion: 3
    widthMultiplier: 0.5
--- !u!114 &501
MonoBehaviour:
  m_GameObject: {fileID: 100}
  m_Enabled: 1
  m_Script: {fileID: 11500000, guid: ffffffffffffffffffffffffffffffff, type: 3}
  beamLength: 30
  beamEndPrefab: {fileID: 1234, guid: ${mat}, type: 3}
  beamCollides: 1
`;
  }
  return out;
}

export function materialYaml(shaderGuid: string, texGuid: string): string {
  return `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!21 &2100000
Material:
  m_ObjectHideFlags: 0
  m_Name: Fire
  m_Shader: {fileID: 4800000, guid: ${shaderGuid}, type: 3}
  m_SavedProperties:
    serializedVersion: 3
    m_TexEnvs:
    - _MainTex:
        m_Texture: {fileID: 2800000, guid: ${texGuid}, type: 3}
        m_Scale: {x: 1, y: 1}
        m_Offset: {x: 0, y: 0}
    - _Empty:
        m_Texture: {fileID: 0}
`;
}
