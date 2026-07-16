import fs from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const notices = await fs.readFile(path.join(process.cwd(), 'THIRD_PARTY_NOTICES.md'), 'utf8');
    return new NextResponse(notices, {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': 'inline; filename="THIRD_PARTY_NOTICES.md"',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return NextResponse.json({
      success: false,
      error: 'Third-party notices are unavailable.',
    }, { status: 500 });
  }
}
