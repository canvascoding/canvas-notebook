import { headers } from 'next/headers';
import { NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  listOrganizationCapabilityPolicies,
  removeOrganizationCapabilityPolicy,
  setOrganizationCapabilityPolicy,
} from '@/app/lib/capabilities/management-actions';
import { CapabilityPolicyConflictError } from '@/app/lib/capabilities/policy-store';
import type {
  CapabilityPolicyEffect,
  CapabilityPolicyTargetType,
  CapabilityResourceType,
} from '@/app/lib/capabilities/types';
import { OrganizationPermissionError, readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { listOrganizationPolicyTargets } from '@/app/lib/organization/policy-targets';

async function requestContext() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) };
  const state = await readOrganizationPermissionForUser(session.user.id);
  if (!state.organizationId || !state.permission || state.permission.status !== 'active') {
    return { response: NextResponse.json({ success: false, error: 'Active organization membership required' }, { status: 403 }) };
  }
  return { session, state };
}

function errorResponse(error: unknown) {
  if (error instanceof CapabilityPolicyConflictError) {
    return NextResponse.json({ success: false, code: error.code, error: error.message }, { status: error.status });
  }
  if (error instanceof OrganizationPermissionError) {
    return NextResponse.json({ success: false, code: error.code, error: error.message }, { status: error.status });
  }
  return NextResponse.json(
    { success: false, error: error instanceof Error ? error.message : 'Capability policy request failed' },
    { status: 400 },
  );
}

export async function GET() {
  const context = await requestContext();
  if ('response' in context) return context.response;
  try {
    const policies = await listOrganizationCapabilityPolicies({
      organizationId: context.state.organizationId!,
      permission: context.state.permission!,
    });
    const targets = await listOrganizationPolicyTargets(context.state.organizationId!);
    return NextResponse.json({ success: true, policies, targets });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request) {
  const context = await requestContext();
  if ('response' in context) return context.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const policy = await setOrganizationCapabilityPolicy({
      organizationId: context.state.organizationId!,
      actorUserId: context.session!.user.id,
      permission: context.state.permission!,
      resourceType: body.resourceType as CapabilityResourceType,
      resourceId: typeof body.resourceId === 'string' ? body.resourceId : '',
      targetType: body.targetType as CapabilityPolicyTargetType,
      targetId: typeof body.targetId === 'string' ? body.targetId : '',
      effect: body.effect as CapabilityPolicyEffect,
      expectedRevision: typeof body.expectedRevision === 'number' ? body.expectedRevision : null,
    });
    return NextResponse.json({ success: true, policy });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  const context = await requestContext();
  if ('response' in context) return context.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const removed = await removeOrganizationCapabilityPolicy({
      organizationId: context.state.organizationId!,
      actorUserId: context.session!.user.id,
      permission: context.state.permission!,
      policyId: typeof body.policyId === 'string' ? body.policyId : '',
      expectedRevision: typeof body.expectedRevision === 'number' ? body.expectedRevision : 0,
    });
    return NextResponse.json({ success: true, removed });
  } catch (error) {
    return errorResponse(error);
  }
}
