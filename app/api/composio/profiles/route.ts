import { NextRequest, NextResponse } from 'next/server';

import { clearComposioGatewayCaches } from '@/app/lib/composio/composio-gateway';
import { requireComposioRequestContext } from '@/app/lib/composio/composio-request';
import { toPublicComposioProfile, toPublicEffectiveComposioContext } from '@/app/lib/composio/composio-context';
import {
  ComposioProfileError,
  createComposioProfile,
  listComposioProfiles,
} from '@/app/lib/composio/composio-profiles';

function errorResponse(error: unknown) {
  return NextResponse.json({
    success: false,
    code: error instanceof ComposioProfileError ? error.code : 'COMPOSIO_PROFILES_FAILED',
    error: error instanceof Error ? error.message : 'Could not manage connection profiles.',
  }, { status: error instanceof ComposioProfileError ? error.status : 500 });
}

export async function GET(request: NextRequest) {
  const contextResult = await requireComposioRequestContext(request);
  if (contextResult.response) return contextResult.response;

  try {
    const profiles = await listComposioProfiles(contextResult.session.user.id);
    return NextResponse.json({
      success: true,
      profiles: profiles.map(toPublicComposioProfile),
      effectiveProfile: toPublicEffectiveComposioContext(contextResult.composioContext),
      workspace: {
        id: contextResult.workspace.workspaceId,
        name: contextResult.workspace.displayName || null,
        type: contextResult.workspace.workspaceType,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const contextResult = await requireComposioRequestContext(request);
  if (contextResult.response) return contextResult.response;

  try {
    const payload = await request.json().catch(() => null) as { name?: unknown } | null;
    const profile = await createComposioProfile({
      ownerUserId: contextResult.session.user.id,
      name: payload?.name,
    });
    clearComposioGatewayCaches(contextResult.composioContext);
    return NextResponse.json({
      success: true,
      profile: toPublicComposioProfile(profile),
    }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
