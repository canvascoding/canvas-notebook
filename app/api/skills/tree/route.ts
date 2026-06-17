import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { auth } from '@/app/lib/auth';
import { getSkillsDir } from '@/app/lib/skills/canvas-skill-manifest';
import { buildSkillTree } from '@/app/lib/skills/skill-tree';

const SKILLS_DIR = getSkillsDir();

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

    const tree = await buildSkillTree(resolvedSkillsDir, { maxDepth: depth });

    return NextResponse.json({ success: true, data: tree });
  } catch (error) {
    console.error('[Skills Tree API] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to load skill tree' },
      { status: 500 }
    );
  }
}
