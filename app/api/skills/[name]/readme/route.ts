import { NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { promises as fs } from 'fs';
import path from 'path';
import { headers } from 'next/headers';

// Skills directory is relative to DATA
const DATA = process.env.DATA || '/data';
const SKILLS_DIR = path.join(DATA, 'skills');

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
    const skillMdPath = path.join(SKILLS_DIR, name, 'SKILL.md');
    
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
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

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
    if (!resolvedPath.startsWith(resolvedSkillsDir)) {
      return NextResponse.json(
        { success: false, error: 'Invalid path' },
        { status: 400 }
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
