import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { clearComposioGatewayCaches, connectGatewayToolkit, getComposioGatewayMode } from '@/app/lib/composio/composio-gateway';
import { requireComposioRequestContext } from '@/app/lib/composio/composio-request';
import { resolveBoundComposioContext, toPublicEffectiveComposioContext } from '@/app/lib/composio/composio-context';
import { ComposioProfileError } from '@/app/lib/composio/composio-profiles';
import { readBoundedJson } from '@/app/lib/api/bounded-json';
import { safeAppReturnTo } from '@/app/lib/auth/return-to';

const connectBody = z.object({ returnPath: z.string().min(1).max(4_096).optional(),
  profileId: z.string().min(1).max(256).refine(value => value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value)).optional() }).strict();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ toolkit: string }> },
) {
  const contextResult = await requireComposioRequestContext(request);
  if (contextResult.response) return contextResult.response;

  try {
    // Existing automation/mobile callers may omit the body. A malformed body,
    // client owner/entity override, or an empty profile is never a fallback.
    const bodyResult = request.body === null ? { body: {}, response: null } : await readBoundedJson(request, 16 * 1_024);
    if (bodyResult.response) return bodyResult.response;
    const body = connectBody.safeParse(bodyResult.body);
    if (!body.success) return NextResponse.json({ code: 'COMPOSIO_CONNECT_INVALID', error: 'The connection request contains invalid or unsupported fields.' }, { status: 400 });
    const returnPath = body.data.returnPath === undefined ? undefined : safeAppReturnTo(body.data.returnPath);
    if (body.data.returnPath !== undefined && !returnPath) {
      return NextResponse.json({ error: 'The app return path is invalid.' }, { status: 400 });
    }
    const composioContext = body.data.profileId === undefined ? contextResult.composioContext : await resolveBoundComposioContext({
      userId: contextResult.session.user.id, workspaceId: contextResult.workspace.workspaceId, profileId: body.data.profileId,
    });
    if ((await getComposioGatewayMode(composioContext)) === 'disabled') {
      return NextResponse.json({ error: 'Composio not configured' }, { status: 400 });
    }

    const { toolkit } = await params;
    if (!/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(toolkit)) {
      return NextResponse.json({ error: 'Toolkit slug is required' }, { status: 400 });
    }

    const { redirectUrl, noAuth } = await connectGatewayToolkit(toolkit, composioContext, { returnPath });
    if (noAuth) {
      clearComposioGatewayCaches(composioContext);
      return NextResponse.json({
        noAuth: true,
        redirectUrl: null,
        effectiveProfile: toPublicEffectiveComposioContext(composioContext),
      });
    }
    return NextResponse.json({
      redirectUrl,
      effectiveProfile: toPublicEffectiveComposioContext(composioContext),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message, ...(error instanceof ComposioProfileError ? { code: error.code } : {}) },
      { status: error instanceof ComposioProfileError ? error.status : 500 });
  }
}
