import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { headers } from 'next/headers';

import { auth } from '@/app/lib/auth';
import { assertReadableCapabilityCandidate, resolveReadableCapabilityCandidate } from '@/app/lib/capabilities/resources/read';
import { CapabilityResourceError } from '@/app/lib/capabilities/resources/contracts';
import { resolveCapabilitySkillFile } from '@/app/lib/skills/capability-skill-browser';

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

function sanitizeAssetPath(filePath: string): string {
  return filePath
    .replace(/\0/g, '')
    .replace(/\.\./g, '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\//, '')
    .replace(/\/$/, '');
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const requestedPath = request.nextUrl.searchParams.get('path');
  if (!requestedPath) {
    return NextResponse.json({ success: false, error: 'path parameter is required' }, { status: 400 });
  }

  const sanitizedPath = sanitizeAssetPath(requestedPath);
  const ext = path.extname(sanitizedPath).toLowerCase();
  const contentType = IMAGE_CONTENT_TYPES[ext];
  if (!contentType) {
    return NextResponse.json({ success: false, error: 'Only image assets are supported' }, { status: 400 });
  }

  try {
    const actor = { userId: session.user.id, workspaceId: request.nextUrl.searchParams.get('workspaceId') };
    const resourceId = request.nextUrl.searchParams.get('resourceId') || undefined;
    const [skillName, ...relativeParts] = sanitizedPath.split('/');
    const selected = await resolveReadableCapabilityCandidate(actor, { resourceType: 'skill', resourceId,
      name: resourceId ? undefined : skillName });
    const resolved = await resolveCapabilitySkillFile(selected.candidates, { resourceId: selected.candidate.ref.resourceId,
      relativePath: resourceId ? sanitizedPath : relativeParts.join('/') });
    const resolvedPath = resolved.filePath;
    const bytes = await fs.readFile(resolvedPath);
    await assertReadableCapabilityCandidate(actor, selected.candidate, selected.candidates);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Type': contentType,
      },
    });
  } catch (error) {
    if (error instanceof CapabilityResourceError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ success: false, error: 'Asset not found' }, { status: 404 });
    }
    console.error('[Skills Asset API] Error:', error);
    return NextResponse.json({ success: false, error: 'Failed to read asset' }, { status: 500 });
  }
}
