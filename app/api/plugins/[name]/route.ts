import { isCapabilityPackageError } from '@/app/lib/capabilities/packages/contracts';
import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { toPublicCapabilityPackageMetadata } from '@/app/lib/capabilities/packages/public-metadata';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { refreshCapabilityRuntimeForScope } from '@/app/lib/capabilities/activation-actions';
import { auth } from '@/app/lib/auth';
import { readReadableCapabilityPlugin } from '@/app/lib/capabilities/resources/read';
import { CapabilityResourceError } from '@/app/lib/capabilities/resources/contracts';
import { resolveCapabilityStorageScope } from '@/app/lib/capabilities/request-scope';
import { requireOrganizationPermission } from '@/app/lib/organization/permissions';
import { deleteCanvasPlugin, getCanvasPlugin } from '@/app/lib/plugins/canvas-plugin-registry';
import { isValidCanvasPluginName } from '@/app/lib/plugins/canvas-plugin-manifest';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { name } = await params;
  if (!isValidCanvasPluginName(name)) {
    return NextResponse.json({ success: false, error: 'Invalid plugin name' }, { status: 400 });
  }

  try {
    const query = new URL(request.url).searchParams;
    const selected = await readReadableCapabilityPlugin({ userId: session.user.id, workspaceId: query.get('workspaceId') }, {
      name, resourceId: query.get('resourceId') || undefined, scope: query.get('scope') === 'organization' ? 'organization' : 'user',
    });
    if (selected.candidate.ref.scopeType === 'organization' && query.get('scope') !== 'organization') {
      throw new CapabilityResourceError('CAPABILITY_RESOURCE_NOT_FOUND', 'Plugin not found.', 404);
    }
    const foreignPersonal = selected.candidate.ref.scopeType === 'user' && selected.candidate.ref.ownerUserId !== session.user.id;
    return NextResponse.json(toPublicCapabilityPackageMetadata({ success: true, plugin: { ...selected.plugin,
      ...(foreignPersonal ? { installDir: '', manifestPath: '', skillsDir: undefined, sourcePath: undefined,
        skills: selected.plugin.skills.map(skill => ({ ...skill, path: '', directory: '', standaloneDir: undefined })) } : {}),
      resourceMetadata: selected.candidate.resourceMetadata, resourceAccess: selected.candidate.resourceAccess,
    } }));
  } catch (error) {
    if (error instanceof CapabilityResourceError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    return NextResponse.json({ success: false, error: 'Plugin unavailable' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const pluginPermission = await requireOrganizationPermission(request, 'canSharePluginsAndSkills', {
    errorMessage: 'Forbidden: plugin and skill sharing permission required',
  });
  if (!pluginPermission.ok) return pluginPermission.response;

  const { name } = await params;
  const capabilityScope = resolveCapabilityStorageScope({
    requestedScope: new URL(request.url).searchParams.get('scope'),
    userId: pluginPermission.session.user.id,
    organizationState: pluginPermission.state,
  });
  const existingPlugin = await getCanvasPlugin(name, capabilityScope);
  let result;
  try {
    result = await deleteCanvasPlugin(
      name,
      capabilityScope,
      pluginPermission.session.user.email || pluginPermission.session.user.id,
    );
  } catch (error) {
    if (isCapabilityPackageError(error)) return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    throw error;
  }
  if (!result.success) {
    return NextResponse.json(
      { success: false, error: result.error },
      { status: result.error?.includes('not found') ? 404 : 400 },
    );
  }
  await recordAuditEvent({
    organizationId: pluginPermission.state.organizationId,
    userId: pluginPermission.session.user.id,
    source: 'plugins',
    eventType: 'plugin',
    entityType: 'canvas_plugin',
    entityId: name,
    action: 'plugin.delete',
    status: 'success',
    summary: `Plugin ${name} deleted.`,
    metadata: {
      pluginName: name,
      scopeType: capabilityScope.scopeType,
      resourceId: existingPlugin?.resourceId,
      sourceType: 'standalone',
      version: existingPlugin?.version,
      checksum: existingPlugin?.checksum,
      revision: existingPlugin?.revision,
      policy: null,
    },
  });
  await refreshCapabilityRuntimeForScope({
    scope: capabilityScope,
    actorUserId: pluginPermission.session.user.id,
  });

  return NextResponse.json({ success: true });
}
