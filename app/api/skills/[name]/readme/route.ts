import { NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { promises as fs } from 'fs';
import path from 'path';
import { headers } from 'next/headers';

// Skills directory is relative to DATA
const DATA = process.env.DATA || '/data';
const SKILLS_DIR = path.join(DATA, 'skills');

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
