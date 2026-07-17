import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { auth } from '@/app/lib/auth';
import { loadCapabilityCandidates } from '@/app/lib/capabilities/catalog';
import { parseCapabilityManagementScope } from '@/app/lib/capabilities/request-scope';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { resolveReadableScopedSkillsDataDir } from '@/app/lib/runtime-data-paths';
import {
  buildCapabilitySkillTree,
  selectBrowsableSkillCandidates,
} from '@/app/lib/skills/capability-skill-browser';
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
    const parsedDepth = Number.parseInt(searchParams.get('depth') || '4', 10);
    const depth = Number.isFinite(parsedDepth) ? Math.min(8, Math.max(1, parsedDepth)) : 4;
    const managementScope = parseCapabilityManagementScope(searchParams.get('scope'));
    const organizationState = await readOrganizationPermissionForUser(session.user.id);

    if (organizationState.organizationId && organizationState.permission?.status === 'active') {
      const candidates = await loadCapabilityCandidates({
        organizationId: organizationState.organizationId,
        userId: session.user.id,
        role: organizationState.permission.role,
      }, { resolveConnections: false });
      const tree = await buildCapabilitySkillTree(
        selectBrowsableSkillCandidates(candidates, managementScope),
        { maxDepth: depth },
      );
      return NextResponse.json({ success: true, data: tree });
    }

    if (managementScope === 'organization') {
      return NextResponse.json(
        { success: false, error: 'Active organization membership required' },
        { status: 403 },
      );
    }

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
