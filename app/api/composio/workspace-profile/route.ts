import { NextRequest, NextResponse } from 'next/server';

import { clearComposioGatewayCaches } from '@/app/lib/composio/composio-gateway';
import {
  composioContextFromEffectiveProfile,
  toPublicEffectiveComposioContext,
} from '@/app/lib/composio/composio-context';
import { requireComposioRequestContext } from '@/app/lib/composio/composio-request';
import {
  clearComposioWorkspaceProfileOverride,
  ComposioProfileError,
  setComposioWorkspaceProfileOverride,
} from '@/app/lib/composio/composio-profiles';

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function errorResponse(error: unknown) {
  return NextResponse.json({
    success: false,
    code: error instanceof ComposioProfileError ? error.code : 'COMPOSIO_WORKSPACE_PROFILE_FAILED',
    error: error instanceof Error ? error.message : 'Could not update the workspace connection profile.',
  }, { status: error instanceof ComposioProfileError ? error.status : 500 });
}

export async function PUT(request: NextRequest) {
  const payload = await request.json().catch(() => null) as Record<string, unknown> | null;
  const workspaceId = stringValue(payload?.workspaceId);
  const profileId = stringValue(payload?.profileId);
  if (!workspaceId || !profileId) {
    return NextResponse.json({
      success: false,
      code: 'COMPOSIO_WORKSPACE_PROFILE_REQUIRED',
      error: 'Workspace and connection profile are required.',
    }, { status: 400 });
  }
  const contextResult = await requireComposioRequestContext(request, { workspaceId });
  if (contextResult.response) return contextResult.response;

  try {
    const effective = await setComposioWorkspaceProfileOverride({
      userId: contextResult.session.user.id,
      workspaceId: contextResult.workspace.workspaceId,
      profileId,
    });
    const nextContext = composioContextFromEffectiveProfile(contextResult.session.user.id, effective);
    clearComposioGatewayCaches(contextResult.composioContext);
    clearComposioGatewayCaches(nextContext);
    return NextResponse.json({
      success: true,
      effectiveProfile: toPublicEffectiveComposioContext(nextContext),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest) {
  const contextResult = await requireComposioRequestContext(request);
  if (contextResult.response) return contextResult.response;

  try {
    const effective = await clearComposioWorkspaceProfileOverride({
      userId: contextResult.session.user.id,
      workspaceId: contextResult.workspace.workspaceId,
    });
    const nextContext = composioContextFromEffectiveProfile(contextResult.session.user.id, effective);
    clearComposioGatewayCaches(contextResult.composioContext);
    clearComposioGatewayCaches(nextContext);
    return NextResponse.json({
      success: true,
      effectiveProfile: toPublicEffectiveComposioContext(nextContext),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
