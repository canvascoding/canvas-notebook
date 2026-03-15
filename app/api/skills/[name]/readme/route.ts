import { NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { promises as fs } from 'fs';
import path from 'path';
import { headers } from 'next/headers';

// Dynamically determine skills directory from WORKSPACE_DIR
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || '/data/workspace';
const SKILLS_DIR = WORKSPACE_DIR.replace(/\/workspace\/?$/, '') + '/skills';

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
