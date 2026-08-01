import { promises as fs } from 'fs';
import path from 'path';
import { headers } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { resolveCapabilityStorageScope } from '@/app/lib/capabilities/request-scope';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { getCanvasPlugin } from '@/app/lib/plugins/canvas-plugin-registry';
import { isPathInside, isValidCanvasPluginName } from '@/app/lib/plugins/canvas-plugin-manifest';

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

  const pluginName = request.nextUrl.searchParams.get('plugin') || '';
  const requestedPath = request.nextUrl.searchParams.get('path') || '';
  if (!isValidCanvasPluginName(pluginName) || !requestedPath) {
    return NextResponse.json({ success: false, error: 'Valid plugin and path are required' }, { status: 400 });
  }

  const scope = resolveCapabilityStorageScope({
    requestedScope: request.nextUrl.searchParams.get('scope'),
    userId: session.user.id,
    organizationState: await readOrganizationPermissionForUser(session.user.id),
  });
  const plugin = await getCanvasPlugin(pluginName, scope);
  if (!plugin) {
    return NextResponse.json({ success: false, error: 'Plugin not found' }, { status: 404 });
  }

  const sanitizedPath = sanitizeAssetPath(requestedPath);
  const contentType = IMAGE_CONTENT_TYPES[path.extname(sanitizedPath).toLowerCase()];
  if (!contentType) {
    return NextResponse.json({ success: false, error: 'Only image assets are supported' }, { status: 400 });
  }

  const fullPath = path.join(plugin.installDir, sanitizedPath);
  if (!isPathInside(plugin.installDir, fullPath)) {
    return NextResponse.json({ success: false, error: 'Invalid path' }, { status: 400 });
  }

  try {
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

    const bytes = await fs.readFile(realFilePath);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'Cache-Control': 'private, max-age=3600',
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff',
        Vary: 'Cookie, Authorization',
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ success: false, error: 'Asset not found' }, { status: 404 });
    }
    console.error('[Mobile Plugins Asset API] Error:', error);
    return NextResponse.json({ success: false, error: 'Failed to load plugin asset' }, { status: 500 });
  }
}
