import { NextResponse } from 'next/server';

import { requireOrganizationPermission } from '@/app/lib/organization/permissions';
import { restoreCanvasSkill } from '@/app/lib/skills/canvas-skill-store';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const skillPermission = await requireOrganizationPermission(request, 'canSharePluginsAndSkills', {
    errorMessage: 'Forbidden: plugin and skill sharing permission required',
  });
  if (!skillPermission.ok) return skillPermission.response;

  try {
    const { name } = await params;
    const body = await request.json().catch(() => ({})) as {
      prefer?: unknown;
      version?: unknown;
      enable?: unknown;
    };
    const prefer = body.prefer === 'seed' || body.prefer === 'store' ? body.prefer : undefined;
    const result = await restoreCanvasSkill(name, {
      prefer,
      version: typeof body.version === 'string' ? body.version.trim() : undefined,
      enable: body.enable !== false,
      scope: { userId: skillPermission.session.user.id },
      updatedBy: skillPermission.session.user.email || skillPermission.session.user.id,
    });

    if (!result.success) {
      return NextResponse.json(result, { status: 400 });
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('[Skills Restore API] Error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to restore skill' },
      { status: 500 },
    );
  }
}
