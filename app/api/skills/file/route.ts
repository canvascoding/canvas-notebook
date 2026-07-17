import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { headers } from 'next/headers';
import { auth } from '@/app/lib/auth';
import { loadCapabilityCandidates } from '@/app/lib/capabilities/catalog';
import { parseCapabilityManagementScope } from '@/app/lib/capabilities/request-scope';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { resolveReadableScopedSkillsDataDir } from '@/app/lib/runtime-data-paths';
import {
  CapabilitySkillFileError,
  resolveCapabilitySkillFile,
  selectBrowsableSkillCandidates,
} from '@/app/lib/skills/capability-skill-browser';
import { resolveCoreSkillFilePath } from '@/app/lib/skills/core-skill-loader';

function sanitizeFilePath(filePath: string): string {
  let clean = filePath;
  clean = clean.replace(/\0/g, '');
  clean = clean.replace(/\.\./g, '');
  clean = clean.replace(/\/\/+/g, '/');
  clean = clean.replace(/^\//, '');
  clean = clean.replace(/\/$/, '');
  return clean;
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const filePath = searchParams.get('path');
    const resourceId = searchParams.get('resourceId')?.trim();

    if (!filePath) {
      return NextResponse.json({ success: false, error: 'path parameter is required' }, { status: 400 });
    }

    if (resourceId) {
      const organizationState = await readOrganizationPermissionForUser(session.user.id);
      if (!organizationState.organizationId || organizationState.permission?.status !== 'active') {
        return NextResponse.json(
          { success: false, error: 'Active organization membership required' },
          { status: 403 },
        );
      }
      const managementScope = parseCapabilityManagementScope(searchParams.get('scope'));
      const candidates = await loadCapabilityCandidates({
        organizationId: organizationState.organizationId,
        userId: session.user.id,
        role: organizationState.permission.role,
      }, { resolveConnections: false });
      const resolved = await resolveCapabilitySkillFile(
        selectBrowsableSkillCandidates(candidates, managementScope),
        { resourceId, relativePath: filePath },
      );
      const content = await fs.readFile(resolved.filePath, 'utf-8');
      return NextResponse.json({
        success: true,
        content,
        name: path.basename(resolved.filePath),
        size: resolved.stat.size,
        modified: resolved.stat.mtimeMs,
      });
    }

    const sanitizedPath = sanitizeFilePath(filePath);
    const corePath = resolveCoreSkillFilePath(sanitizedPath);
    if (corePath) {
      const stat = await fs.stat(corePath);
      if (stat.isDirectory()) {
        return NextResponse.json({ success: false, error: 'Path is a directory, not a file' }, { status: 400 });
      }

      const content = await fs.readFile(corePath, 'utf-8');
      return NextResponse.json({
        success: true,
        content,
        name: path.basename(corePath),
        size: stat.size,
        modified: stat.mtimeMs,
      });
    }

    const skillsDir = await resolveReadableScopedSkillsDataDir({ userId: session.user.id });
    const fullPath = path.join(skillsDir, sanitizedPath);
    const resolvedPath = path.resolve(fullPath);
    const resolvedSkillsDir = path.resolve(skillsDir);

    if (!resolvedPath.startsWith(`${resolvedSkillsDir}${path.sep}`)) {
      return NextResponse.json({ success: false, error: 'Invalid path' }, { status: 400 });
    }

    const stat = await fs.stat(resolvedPath);
    if (stat.isDirectory()) {
      return NextResponse.json({ success: false, error: 'Path is a directory, not a file' }, { status: 400 });
    }

    const content = await fs.readFile(resolvedPath, 'utf-8');

    return NextResponse.json({
      success: true,
      content,
      name: path.basename(resolvedPath),
      size: stat.size,
      modified: stat.mtimeMs,
    });
  } catch (error) {
    if (error instanceof CapabilitySkillFileError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ success: false, error: 'File not found' }, { status: 404 });
    }
    console.error('[Skills File API] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to read file' },
      { status: 500 }
    );
  }
}
