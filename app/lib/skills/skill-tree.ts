import { promises as fs } from 'fs';
import path from 'path';

export interface SkillFileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: number;
  children?: SkillFileNode[];
}

const IGNORED_ENTRIES = new Set(['node_modules', '.cache']);
const IGNORED_ROOT_ENTRIES = new Set(['README.md', 'registry.json', 'registry.json.tmp']);

async function buildSkillTreeFromDir(
  rootDir: string,
  dirPath: string,
  depth: number,
  maxDepth: number,
  isRoot: boolean,
): Promise<SkillFileNode[]> {
  if (depth > maxDepth) return [];

  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const nodes: SkillFileNode[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.agents') continue;
    if (IGNORED_ENTRIES.has(entry.name)) continue;
    if (isRoot && IGNORED_ROOT_ENTRIES.has(entry.name)) continue;

    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(rootDir, fullPath);

    if (entry.isDirectory()) {
      const children = await buildSkillTreeFromDir(rootDir, fullPath, depth + 1, maxDepth, false);
      const stat = await fs.stat(fullPath).catch(() => null);
      nodes.push({
        name: entry.name,
        path: relativePath,
        type: 'directory',
        modified: stat?.mtimeMs,
        children,
      });
    } else {
      const stat = await fs.stat(fullPath).catch(() => null);
      nodes.push({
        name: entry.name,
        path: relativePath,
        type: 'file',
        size: stat?.size,
        modified: stat?.mtimeMs,
      });
    }
  }

  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return nodes;
}

export async function buildSkillTree(
  rootDir: string,
  options: { maxDepth?: number } = {},
): Promise<SkillFileNode[]> {
  const resolvedRoot = path.resolve(rootDir);
  return buildSkillTreeFromDir(resolvedRoot, resolvedRoot, 0, options.maxDepth ?? 4, true);
}
