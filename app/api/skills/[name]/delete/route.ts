import { NextResponse } from 'next/server';
import { requireOrganizationPermission } from '@/app/lib/organization/permissions';
import { coreSkillInstallError, isCoreSkillName } from '@/app/lib/skills/core-skills';
import { deleteSkillDirectory } from '@/app/lib/skills/skill-loader';
import { removeCanvasSkillRegistryRecord } from '@/app/lib/skills/canvas-skill-store';
import { isValidAgentSkillName } from '@/app/lib/skills/canvas-skill-manifest';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  try {
    const skillPermission = await requireOrganizationPermission(request, 'canSharePluginsAndSkills', {
      errorMessage: 'Forbidden: plugin and skill sharing permission required',
    });
    if (!skillPermission.ok) return skillPermission.response;

    const { name } = await params;
    const scope = { userId: skillPermission.session.user.id };

    if (!isValidAgentSkillName(name)) {
      return NextResponse.json(
        { success: false, error: 'Invalid skill name' },
        { status: 400 }
      );
    }
    if (isCoreSkillName(name)) {
      return NextResponse.json(
        { success: false, error: coreSkillInstallError(name) },
        { status: 409 },
      );
    }

    const result = await deleteSkillDirectory(name, scope);

    if (!result.success) {
      const status = result.error?.includes('not found')
        ? 404
        : result.error?.includes('managed by a plugin')
          ? 409
          : 500;
      return NextResponse.json(
        { success: false, error: result.error },
        { status }
      );
    }

    await removeCanvasSkillRegistryRecord(name, scope).catch((registryError) => {
      console.warn('[Skills API] Deleted skill directory but failed to remove registry record:', registryError);
    });

    return NextResponse.json({
      success: true,
      message: `Skill "${name}" deleted successfully`,
    });
  } catch (error) {
    console.error('[Skills API] Error deleting skill:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete skill' },
      { status: 500 }
    );
  }
}
