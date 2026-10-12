import 'server-only';
import { NextRequest } from 'next/server';
import type { CapabilityResourceActor } from '@/app/lib/capabilities/resources/contracts';
import { isCapabilityPackageError } from '@/app/lib/capabilities/packages/contracts';
import { toPublicCapabilityPackageMetadata } from '@/app/lib/capabilities/packages/public-metadata';
import { MobileScopedError, mobileScopedError, mobileScopedJson, mobileScopedResponse, requireMobileScopedContext,
  revalidateMobileScopedContext } from './scoped-route-v2';

type RouteContext = { params: Promise<Record<string, string>> };

/** Native facade over existing package actions, with the same original-context guard as other V2 surfaces. */
export function mobileCapabilityPackageRoute(
  action: (request: NextRequest, actor: CapabilityResourceActor, params: Record<string, string>, body: Record<string, unknown>) => Promise<Record<string, unknown>>,
  queryKeys: readonly string[] = [],
) {
  return async (request: NextRequest, route: RouteContext = { params: Promise.resolve({}) }) => {
    try {
      const context = await requireMobileScopedContext(request, queryKeys);
      const body = request.method === 'GET' ? {} : await mobileScopedJson(request, 16_384);
      const params = await route.params;
      await revalidateMobileScopedContext(context);
      const result = await action(request, { userId: context.userId, workspaceId: context.workspaceId }, params, body);
      return await mobileScopedResponse(context, toPublicCapabilityPackageMetadata(result));
    } catch (error) {
      return mobileScopedError(isCapabilityPackageError(error)
        ? new MobileScopedError(error.code, 'The package request is unavailable.', error.status) : error);
    }
  };
}
