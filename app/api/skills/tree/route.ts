import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { auth } from '@/app/lib/auth';

const DATA = process.env.DATA || '/data';
const SKILLS_DIR = path.join(DATA, 'skills');

interface SkillFileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: number;
  children?: SkillFileNode[];
}

async function buildSkillTree(dirPath: string, depth: number, maxDepth: number): Promise<SkillFileNode[]> {
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

    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.relative(SKILLS_DIR, fullPath);

    if (entry.isDirectory()) {
      const children = await buildSkillTree(fullPath, depth + 1, maxDepth);
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

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const depth = parseInt(searchParams.get('depth') || '4');

    const resolvedSkillsDir = path.resolve(SKILLS_DIR);

    try {
      await fs.access(resolvedSkillsDir);
    } catch {
      return NextResponse.json({ success: true, data: [] });
    }

    const tree = await buildSkillTree(resolvedSkillsDir, 0, depth);

    return NextResponse.json({ success: true, data: tree });
  } catch (error) {
    console.error('[Skills Tree API] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to load skill tree' },
      { status: 500 }
    );
  }
}