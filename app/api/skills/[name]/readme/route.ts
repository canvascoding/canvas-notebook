import { NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { promises as fs } from 'fs';
import path from 'path';
import { headers } from 'next/headers';
import { requireOrganizationPermission } from '@/app/lib/organization/permissions';
import { getSkillsDir } from '@/app/lib/skills/canvas-skill-manifest';
import { loadSkillByName } from '@/app/lib/skills/skill-loader';

const SKILLS_DIR = getSkillsDir();

function sanitizeSkillName(name: string): string {
  return name.replace(/[^a-z0-9-]/g, '');
}

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
    const skill = await loadSkillByName(name);
    if (!skill) {
      return NextResponse.json(
        { success: false, error: 'Skill not found' },
        { status: 404 },
      );
    }
    const skillMdPath = skill.path;
    
    // Read SKILL.md file
    const content = await fs.readFile(skillMdPath, 'utf-8');
    
    return NextResponse.json({
      success: true,
      content,
    });
  } catch (error) {
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
    const sanitizedName = sanitizeSkillName(name);
    
    if (!sanitizedName) {
      return NextResponse.json(
        { success: false, error: 'Invalid skill name' },
        { status: 400 }
      );
    }

    const skillMdPath = path.join(SKILLS_DIR, sanitizedName, 'SKILL.md');
    
    // Verify the path is within the skills directory (path traversal protection)
    const resolvedPath = path.resolve(/*turbopackIgnore: true*/ skillMdPath);
    const resolvedSkillsDir = path.resolve(/*turbopackIgnore: true*/ SKILLS_DIR);
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
    await fs.writeFile(skillMdPath, content, 'utf-8');

    return NextResponse.json({
      success: true,
      message: 'Skill updated successfully',
    });
  } catch (error) {
    console.error(`[Skills API] Error saving SKILL.md for skill:`, error);
    return NextResponse.json(
      { success: false, error: 'Failed to save SKILL.md' },
      { status: 500 }
    );
  }
}
