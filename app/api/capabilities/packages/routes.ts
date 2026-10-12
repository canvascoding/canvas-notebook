import 'server-only';

import { NextResponse } from 'next/server';
import type { CapabilityResourceActor } from '@/app/lib/capabilities/resources/contracts';
import { CapabilityPackageError } from '@/app/lib/capabilities/packages/contracts';
import { packageRequestActor, packageResponse, packageResponseError } from './http';

type RouteContext = { params: Promise<Record<string, string>> };
export function capabilityPackageRoute(callback: (request: Request, actor: CapabilityResourceActor,
  params: Record<string, string>) => Promise<Record<string, unknown>>) {
  return async (request: Request, context: RouteContext) => {
    try {
      const actor = await packageRequestActor(request);
      if (actor instanceof NextResponse) return actor;
      return packageResponse(await callback(request, actor, await context.params));
    } catch (error) { return packageResponseError(error); }
  };
}

export function capabilityPackageQuery(request: Request, fields: readonly string[]): Record<string, string | number> {
  const query = new URL(request.url).searchParams, result: Record<string, string | number> = {};
  for (const [name, value] of query) {
    if (name === 'workspaceId') continue;
    if (!fields.includes(name) || query.getAll(name).length !== 1) {
      throw new CapabilityPackageError('PACKAGE_REQUEST_INVALID', 'The package query is invalid.');
    }
    result[name] = name === 'offset' || name === 'maxBytes' ? /^\d+$/u.test(value) ? Number(value) : NaN : value;
  }
  return result;
}
