import fs from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const inventoryPath = path.join(process.cwd(), 'docs/compliance/third-party-components.json');
    const inventory = JSON.parse(await fs.readFile(inventoryPath, 'utf8')) as {
      packageVersion: string;
      lockfileSha256: string;
      summary: Record<string, number>;
      releaseGate: {
        status: 'approved' | 'blocked';
        approvalStatus: 'pending' | 'approved';
        approvalReviewedBy: string | null;
        approvalReviewedAt: string | null;
        blockers: Array<{ name: string; versionOrCommit: string; reason: string }>;
      };
    };
    return NextResponse.json({
      success: true,
      packageVersion: inventory.packageVersion,
      lockfileSha256: inventory.lockfileSha256,
      summary: inventory.summary,
      releaseGate: inventory.releaseGate,
    }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json({
      success: false,
      error: 'Third-party inventory is unavailable.',
    }, { status: 500 });
  }
}
