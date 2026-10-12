import { promises as fs } from 'fs';
import path from 'path';
import { headers } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { CapabilityResourceError } from '@/app/lib/capabilities/resources/contracts';
import { assertReadableCapabilityCandidate, readReadableCapabilityPlugin } from '@/app/lib/capabilities/resources/read';
import { isPathInside, isValidCanvasPluginName } from '@/app/lib/plugins/canvas-plugin-manifest';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

function sanitizeAssetPath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.includes('\0') || normalized.startsWith('/') || /^[a-z]:/iu.test(normalized)
    || normalized.split('/').includes('..')) return null;
  return normalized
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const pluginName = request.nextUrl.searchParams.get('plugin') || '';
  const requestedPath = request.nextUrl.searchParams.get('path') || '';
  if (!isValidCanvasPluginName(pluginName) || !requestedPath) {
    return NextResponse.json({ success: false, error: 'Valid plugin and path are required' }, { status: 400 });
  }

  const sanitizedPath = sanitizeAssetPath(requestedPath);
  if (!sanitizedPath) {
    return NextResponse.json({ success: false, error: 'Invalid path' }, { status: 400 });
  }
  const contentType = IMAGE_CONTENT_TYPES[path.extname(sanitizedPath).toLowerCase()];
  if (!contentType) {
    return NextResponse.json({ success: false, error: 'Only image assets are supported' }, { status: 400 });
  }

  const query = request.nextUrl.searchParams;
  const resourceId = query.get('resourceId')?.trim() || undefined;
  const workspaceId = query.get('workspaceId')?.trim() || request.headers.get(WORKSPACE_ID_HEADER)?.trim() || null;
  if (query.has('resourceId') && (!resourceId || resourceId.length > 512) || workspaceId && workspaceId.length > 256) {
    return NextResponse.json({ success: false, error: 'Invalid plugin selection' }, { status: 400 });
  }
  const scope = query.get('scope') === 'organization' ? 'organization' : 'user';
  const actor = { userId: session.user.id, workspaceId };

  try {
    const selected = await readReadableCapabilityPlugin(actor, { name: pluginName, resourceId, scope });
    if (selected.candidate.ref.scopeType === 'organization' && scope !== 'organization') {
      return NextResponse.json({ success: false, error: 'Plugin not found' }, { status: 404 });
    }
    const plugin = selected.plugin;
    const fullPath = path.join(plugin.installDir, sanitizedPath);
    if (!isPathInside(plugin.installDir, fullPath)) {
      return NextResponse.json({ success: false, error: 'Invalid path' }, { status: 400 });
    }
    await assertReadableCapabilityCandidate(actor, selected.candidate, selected.candidates);
    const stat = await fs.lstat(fullPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return NextResponse.json({ success: false, error: 'Asset is not a regular file' }, { status: 400 });
    }
    const [realInstallDir, realFilePath] = await Promise.all([
      fs.realpath(plugin.installDir),
      fs.realpath(fullPath),
    ]);
    if (!isPathInside(realInstallDir, realFilePath)) {
      return NextResponse.json({ success: false, error: 'Invalid path' }, { status: 400 });
    }

    await assertReadableCapabilityCandidate(actor, selected.candidate, selected.candidates);
    const bytes = await fs.readFile(realFilePath);
    await assertReadableCapabilityCandidate(actor, selected.candidate, selected.candidates);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff',
        Vary: 'Cookie, Authorization',
      },
    });
  } catch (error) {
    if (error instanceof CapabilityResourceError) {
      const status = [403, 404].includes(error.status) ? 404 : 500;
      return NextResponse.json({ success: false, error: status === 404 ? 'Plugin not found' : 'Plugin unavailable' }, { status });
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ success: false, error: 'Asset not found' }, { status: 404 });
    }
    console.error('[Mobile Plugins Asset API] Error:', error);
    return NextResponse.json({ success: false, error: 'Failed to load plugin asset' }, { status: 500 });
  }
}
