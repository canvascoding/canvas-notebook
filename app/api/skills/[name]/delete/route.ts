import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/app/lib/auth';
import { deleteSkillDirectory } from '@/app/lib/skills/skill-loader';
import { removeCanvasSkillRegistryRecord } from '@/app/lib/skills/canvas-skill-store';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { name } = await params;

    if (!name || !/^[a-z0-9]+([a-z0-9-]*[a-z0-9]+)?$/.test(name)) {
      return NextResponse.json(
        { success: false, error: 'Invalid skill name' },
        { status: 400 }
      );
    }

    const result = await deleteSkillDirectory(name);

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

    await removeCanvasSkillRegistryRecord(name).catch((registryError) => {
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
