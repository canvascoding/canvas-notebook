import { promises as fs } from 'fs';
import path from 'path';
import { headers } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { resolveEffectiveCapabilitySnapshot } from '@/app/lib/capabilities/catalog';
import { resolveCapabilityExecutionContextForUser } from '@/app/lib/capabilities/request-scope';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { readExactInstalledPlugin } from '@/app/lib/plugins/installed-plugin-read';
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
  if (normalized.includes('\0') || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)
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
  if (!isValidCanvasPluginName(pluginName)) {
    return NextResponse.json({ success: false, error: 'Valid plugin parameter is required' }, { status: 400 });
  }
  if (!requestedPath) {
    return NextResponse.json({ success: false, error: 'path parameter is required' }, { status: 400 });
  }

  const scopeType = request.nextUrl.searchParams.get('scope') === 'organization' ? 'organization' : 'user';
  const resourceId = request.nextUrl.searchParams.get('resourceId')?.trim() || undefined;
  if (request.nextUrl.searchParams.has('resourceId') && (!resourceId || resourceId.length > 512)) {
    return NextResponse.json({ success: false, error: 'Invalid plugin resource identity' }, { status: 400 });
  }
  let organizationId: string | undefined;
  if (scopeType === 'organization') {
    const organizationState = await readOrganizationPermissionForUser(session.user.id);
    if (!resourceId || !organizationState.organizationId || organizationState.permission?.status !== 'active') {
      return NextResponse.json({ success: false, error: 'Assigned organization plugin access required' }, { status: 403 });
    }
    organizationId = organizationState.organizationId;
    try {
      const executionContext = await resolveCapabilityExecutionContextForUser({
        userId: session.user.id,
        organizationId,
        role: organizationState.permission.role,
        requestedWorkspaceId: request.nextUrl.searchParams.get('workspaceId') || request.headers.get(WORKSPACE_ID_HEADER),
      });
      if (organizationState.permission.canSharePluginsAndSkills !== true) {
        const snapshot = await resolveEffectiveCapabilitySnapshot(executionContext);
        const assignedPlugin = snapshot.capabilities.find((entry) => (
          entry.ref.resourceType === 'plugin'
          && entry.ref.scopeType === 'organization'
          && entry.ref.resourceId === resourceId
          && entry.ref.name === pluginName
          && entry.effectivePolicy !== 'blocked'
          && entry.readiness !== 'conflict'
        ));
        if (!assignedPlugin) {
          return NextResponse.json({ success: false, error: 'Assigned organization plugin access required' }, { status: 403 });
        }
      }
    } catch {
      return NextResponse.json({ success: false, error: 'Assigned plugin is unavailable in this workspace' }, { status: 403 });
    }
  }
  const plugin = await readExactInstalledPlugin({
    name: pluginName,
    resourceId,
    scope: scopeType === 'organization'
      ? { scopeType: 'organization', organizationId: organizationId! }
      : { scopeType: 'user', userId: session.user.id },
  });
  if (!plugin) {
    return NextResponse.json({ success: false, error: 'Plugin not found' }, { status: 404 });
  }

  const sanitizedPath = sanitizeAssetPath(requestedPath);
  if (!sanitizedPath) {
    return NextResponse.json({ success: false, error: 'Invalid path' }, { status: 400 });
  }
  const ext = path.extname(sanitizedPath).toLowerCase();
  const contentType = IMAGE_CONTENT_TYPES[ext];
  if (!contentType) {
    return NextResponse.json({ success: false, error: 'Only image assets are supported' }, { status: 400 });
  }

  const fullPath = path.join(plugin.installDir, sanitizedPath);
  if (!isPathInside(plugin.installDir, fullPath)) {
    return NextResponse.json({ success: false, error: 'Invalid path' }, { status: 400 });
  }

  try {
    const stat = await fs.lstat(fullPath);
    if (stat.isSymbolicLink()) {
      return NextResponse.json({ success: false, error: 'Symbolic links are not supported' }, { status: 400 });
    }
    if (!stat.isFile()) {
      return NextResponse.json({ success: false, error: 'Path is not a file' }, { status: 400 });
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
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ success: false, error: 'Asset not found' }, { status: 404 });
    }
    console.error('[Plugins Asset API] Error:', error);
    return NextResponse.json({ success: false, error: 'Failed to read asset' }, { status: 500 });
  }
}
