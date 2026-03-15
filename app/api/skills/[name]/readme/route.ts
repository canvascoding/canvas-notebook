import { NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { promises as fs } from 'fs';
import path from 'path';

// Dynamically determine skills directory from WORKSPACE_DIR
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || '/data/workspace';
const SKILLS_DIR = WORKSPACE_DIR.replace(/\/workspace\/?$/, '') + '/skills';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const session = await auth.api.getSession({ headers: new Headers() });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { name } = await params;
    const readmePath = path.join(SKILLS_DIR, name, 'README.md');
    
    // Read README file
    const content = await fs.readFile(readmePath, 'utf-8');
    
    return NextResponse.json({
      success: true,
      content,
    });
  } catch (error) {
    console.error(`[Skills API] Error reading README for skill:`, error);
    return NextResponse.json(
      { success: false, error: 'Failed to read README' },
      { status: 500 }
    );
  }
}
