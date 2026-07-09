import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { auth } from '@/app/lib/auth';
import { resolveReadableScopedSkillsDataDir } from '@/app/lib/runtime-data-paths';
import { buildSkillTree, type SkillFileNode } from '@/app/lib/skills/skill-tree';
import { CORE_SKILL_NAMES } from '@/app/lib/skills/core-skills';
import { CORE_SKILLS_DIR } from '@/app/lib/skills/core-skill-loader';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const depth = parseInt(searchParams.get('depth') || '4');

    const resolvedSkillsDir = path.resolve(await resolveReadableScopedSkillsDataDir({ userId: session.user.id }));

    const coreTree = await buildSkillTree(CORE_SKILLS_DIR, {
      maxDepth: depth,
      includeRootNames: CORE_SKILL_NAMES,
    });
    const coreSkillNames = new Set(coreTree.map((node) => node.name));
    let userTree: SkillFileNode[] = [];
    try {
      await fs.access(resolvedSkillsDir);
      userTree = (await buildSkillTree(resolvedSkillsDir, { maxDepth: depth }))
        .filter((node) => !coreSkillNames.has(node.name));
    } catch {
      userTree = [];
    }

    const tree = [...coreTree, ...userTree];

    return NextResponse.json({ success: true, data: tree });
  } catch (error) {
    console.error('[Skills Tree API] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to load skill tree' },
      { status: 500 }
    );
  }
}
