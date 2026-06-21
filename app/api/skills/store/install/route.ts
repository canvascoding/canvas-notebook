import { NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { requireOrganizationPermission } from '@/app/lib/organization/permissions';
import { installCanvasSkillFromStore } from '@/app/lib/skills/canvas-skill-store';

export async function POST(request: Request) {
  const skillPermission = await requireOrganizationPermission(request, 'canSharePluginsAndSkills', {
    errorMessage: 'Forbidden: plugin and skill sharing permission required',
  });
  if (!skillPermission.ok) return skillPermission.response;

  try {
    const body = await request.json() as {
      name?: unknown;
      version?: unknown;
      enable?: unknown;
      replace?: unknown;
    };

    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      return NextResponse.json(
        { success: false, error: 'name is required' },
        { status: 400 },
      );
    }

    const result = await installCanvasSkillFromStore(
      body.name.trim(),
      typeof body.version === 'string' ? body.version.trim() : undefined,
      {
        enable: body.enable !== false,
        replace: body.replace !== false,
        scope: { userId: skillPermission.session.user.id },
        updatedBy: skillPermission.session.user.email || skillPermission.session.user.id,
      },
    );

    if (!result.success) {
      return NextResponse.json(result, { status: 400 });
    }
    await recordAuditEvent({
      organizationId: skillPermission.state.organizationId,
      userId: skillPermission.session.user.id,
      source: 'skills',
      eventType: 'plugin',
      entityType: 'canvas_skill',
      entityId: body.name.trim(),
      action: 'skill.install_from_store',
      status: 'success',
      summary: `Skill ${body.name.trim()} installed from store.`,
      metadata: {
        skillName: body.name.trim(),
        requestedVersion: typeof body.version === 'string' ? body.version.trim() : null,
        enable: body.enable !== false,
        replace: body.replace !== false,
      },
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error('[Skills Store Install API] Error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to install skill' },
      { status: 500 },
    );
  }
}
