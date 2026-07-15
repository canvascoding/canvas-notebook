import { NextResponse } from 'next/server';

import { setPersonalCapabilityActivation } from '@/app/lib/capabilities/activation-actions';
import {
  CapabilityPreferenceConflictError,
} from '@/app/lib/capabilities/preference-store';
import { requireActiveCapabilityUser } from '@/app/lib/capabilities/request-auth';

export async function PUT(request: Request) {
  const capabilityUser = await requireActiveCapabilityUser(request);
  if (!capabilityUser.ok) return capabilityUser.response;
  if (!capabilityUser.state.organizationId || !capabilityUser.state.permission) {
    return NextResponse.json({ success: false, error: 'Organization setup required' }, { status: 409 });
  }

  try {
    const body = await request.json() as Record<string, unknown>;
    const resourceId = typeof body.resourceId === 'string' ? body.resourceId.trim() : '';
    const enabled = body.enabled;
    if (!resourceId || typeof enabled !== 'boolean') {
      return NextResponse.json({ success: false, error: 'resourceId and enabled are required' }, { status: 400 });
    }
    const result = await setPersonalCapabilityActivation({
      context: {
      organizationId: capabilityUser.state.organizationId,
      userId: capabilityUser.session.user.id,
      role: capabilityUser.state.permission.role,
      },
      actorUserId: capabilityUser.session.user.id,
      resourceId,
      enabled,
      expectedRevision: typeof body.expectedRevision === 'number' ? body.expectedRevision : null,
    });
    return NextResponse.json({ success: true, preference: result.preference, resourceId });
  } catch (error) {
    if (error instanceof CapabilityPreferenceConflictError) {
      return NextResponse.json({ success: false, code: error.code, error: error.message }, { status: error.status });
    }
    const status = typeof (error as { status?: unknown })?.status === 'number'
      ? (error as { status: number }).status
      : error instanceof Error && error.message === 'Organization capability not found.' ? 404 : 500;
    return NextResponse.json(
      {
        success: false,
        code: typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : undefined,
        error: error instanceof Error ? error.message : 'Failed to update capability preference',
      },
      { status },
    );
  }
}
