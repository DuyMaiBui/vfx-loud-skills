import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface GraphRules {
  family: { versionTokenPattern: string; stripTokens: string[]; minMembers: number; maxMembers: number };
  pairs: {
    packs: string[];
    roles: Record<string, { terms: string[]; alsoStrip: string[] }>;
    suffixVariantWords: string[];
    versionTokenPattern: string;
    minRoles: number;
    maxSetSize: number;
  };
  assets: { builtinGuidPattern: string; meshKeys: string[] };
  similarity: { kinds: string[]; maxAssetFanout: number; minJaccard: number; topK: number };
  knowledge: { maxPerKnowledge: number };
}

export interface KnowledgeLink {
  ref: string;
  match: Record<string, string[]>;
}

export function loadRules(): GraphRules {
  return JSON.parse(fs.readFileSync(path.join(here, 'rules.json'), 'utf8')) as GraphRules;
}

export function loadKnowledgeLinks(): KnowledgeLink[] {
  return (JSON.parse(fs.readFileSync(path.join(here, 'knowledge-links.json'), 'utf8')) as { links: KnowledgeLink[] }).links;
}
