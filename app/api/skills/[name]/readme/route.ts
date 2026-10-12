import { NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { promises as fs } from 'fs';
import path from 'path';
import { headers } from 'next/headers';
import { assertReadableCapabilityCandidate, resolveReadableCapabilityCandidate } from '@/app/lib/capabilities/resources/read';
import { CapabilityResourceError } from '@/app/lib/capabilities/resources/contracts';
import {
  requireOrganizationPermission,
} from '@/app/lib/organization/permissions';
import { getSkillsDir, isValidAgentSkillName } from '@/app/lib/skills/canvas-skill-manifest';
import { coreSkillInstallError, isCoreSkillName } from '@/app/lib/skills/core-skills';
import { adoptLegacyStandaloneSkillsForScope } from '@/app/lib/skills/legacy-skill-adoption';
import { readCanvasSkillRegistry } from '@/app/lib/skills/canvas-skill-store';
import { assertLegacyCapabilityPackageMutationAllowed, withCapabilityPackageRegistryLock } from '@/app/lib/capabilities/packages/artifacts';
import { isCapabilityPackageError } from '@/app/lib/capabilities/packages/contracts';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { name } = await params;
    const resourceId = new URL(request.url).searchParams.get('resourceId')?.trim();
    const actor = { userId: session.user.id, workspaceId: new URL(request.url).searchParams.get('workspaceId') };
    const selected = await resolveReadableCapabilityCandidate(actor, { resourceType: 'skill', name, resourceId });
    if (!selected.candidate.runtimePath) throw new CapabilityResourceError('CAPABILITY_RESOURCE_NOT_FOUND', 'Skill not found.', 404);
    const content = await fs.readFile(selected.candidate.runtimePath, 'utf-8');
    await assertReadableCapabilityCandidate(actor, selected.candidate, selected.candidates);
    
    return NextResponse.json({
      success: true,
      content,
    });
  } catch (error) {
    if (error instanceof CapabilityResourceError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error(`[Skills API] Error reading SKILL.md for skill:`, error);
    return NextResponse.json(
      { success: false, error: 'Failed to read SKILL.md' },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  try {
    const skillPermission = await requireOrganizationPermission(request, 'canSharePluginsAndSkills', {
      errorMessage: 'Forbidden: plugin and skill sharing permission required',
    });
    if (!skillPermission.ok) return skillPermission.response;

    const { name } = await params;
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

    const scope = { userId: skillPermission.session.user.id };
    await adoptLegacyStandaloneSkillsForScope(scope);
    const skillsDir = getSkillsDir(scope);
    const skillMdPath = path.join(skillsDir, name, 'SKILL.md');
    
    // Verify the path is within the skills directory (path traversal protection)
    const resolvedPath = path.resolve(/*turbopackIgnore: true*/ skillMdPath);
    const resolvedSkillsDir = path.resolve(/*turbopackIgnore: true*/ skillsDir);
    if (!resolvedPath.startsWith(`${resolvedSkillsDir}${path.sep}`)) {
      return NextResponse.json(
        { success: false, error: 'Plugin-managed skills cannot be edited from the standalone skill editor' },
        { status: 409 }
      );
    }

    const body = await request.json();
    const { content } = body;

    if (typeof content !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Content must be a string' },
        { status: 400 }
      );
    }

    // Write updated content to SKILL.md
    await withCapabilityPackageRegistryLock('skill', scope, async () => {
      const current = (await readCanvasSkillRegistry(scope)).skills[name];
      await assertLegacyCapabilityPackageMutationAllowed('skill', name, scope, current);
      await fs.writeFile(skillMdPath, content, 'utf-8');
    });

    return NextResponse.json({
      success: true,
      message: 'Skill updated successfully',
    });
  } catch (error) {
    if (isCapabilityPackageError(error)) return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    console.error(`[Skills API] Error saving SKILL.md for skill:`, error);
    return NextResponse.json(
      { success: false, error: 'Failed to save SKILL.md' },
      { status: 500 }
    );
  }
}
