import fs from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const inventory = await fs.readFile(
      path.join(process.cwd(), 'docs/compliance/third-party-components.json'),
      'utf8',
    );
    return new NextResponse(inventory, {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'inline; filename="third-party-components.json"',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return NextResponse.json({
      success: false,
      error: 'Third-party inventory is unavailable.',
    }, { status: 500 });
  }
}
