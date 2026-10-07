import { headers } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { CapabilityResourceError } from '@/app/lib/capabilities/resources/contracts';
import { assertReadableCapabilityCandidate, readReadableCapabilityPlugin } from '@/app/lib/capabilities/resources/read';
import { serializeMobileInstalledPluginDetail } from '@/app/lib/mobile/extensions';
import { isValidCanvasPluginName } from '@/app/lib/plugins/canvas-plugin-manifest';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ name: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { name } = await context.params;
  if (!isValidCanvasPluginName(name)) {
    return NextResponse.json({ success: false, error: 'Invalid plugin name' }, { status: 400 });
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
    const selected = await readReadableCapabilityPlugin(actor, { name, resourceId, scope });
    if (selected.candidate.ref.scopeType === 'organization' && scope !== 'organization') {
      return NextResponse.json({ success: false, error: 'Plugin not found' }, { status: 404 });
    }
    const plugin = serializeMobileInstalledPluginDetail(selected.plugin);
    await assertReadableCapabilityCandidate(actor, selected.candidate, selected.candidates);
    return NextResponse.json({ success: true, plugin, scope }, {
      headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization' },
    });
  } catch (error) {
    const status = error instanceof CapabilityResourceError && [403, 404].includes(error.status) ? 404 : 500;
    return NextResponse.json({ success: false, error: status === 404 ? 'Plugin not found' : 'Plugin unavailable' }, { status });
  }
}
