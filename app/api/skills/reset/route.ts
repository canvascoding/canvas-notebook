import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { requireOrganizationPermission } from '@/app/lib/organization/permissions';
import { resetCanvasSkillsDirectory } from '@/app/lib/skills/canvas-skill-store';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

const RESET_CONFIRMATION = 'DELETE_SKILLS';

export async function POST(request: NextRequest) {
  const skillPermission = await requireOrganizationPermission(request, 'canSharePluginsAndSkills', {
    errorMessage: 'Forbidden: plugin and skill sharing permission required',
  });
  if (!skillPermission.ok) return skillPermission.response;

  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canManageWorkspace' });
  if (workspaceResult.response) return workspaceResult.response;

  try {
    const body = await request.json().catch(() => ({})) as { confirm?: unknown };
    if (body.confirm !== RESET_CONFIRMATION) {
      return NextResponse.json(
        { success: false, error: `Type ${RESET_CONFIRMATION} to reset all skills.` },
        { status: 400 },
      );
    }

    const result = await resetCanvasSkillsDirectory(workspaceResult.session.user.email || 'unknown');
    return NextResponse.json(result);
  } catch (error) {
    console.error('[Skills API] Error resetting skills directory:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to reset skills directory' },
      { status: 500 },
    );
  }
}
