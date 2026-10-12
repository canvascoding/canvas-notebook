import { NextResponse } from 'next/server';
import { configureCapabilityResource, inspectCapabilityResource, updateCapabilityResource } from '@/app/lib/capabilities/resources/actions';
import type { CapabilityResourceConfiguration, CapabilityResourceMutation } from '@/app/lib/capabilities/resources/contracts';
import { resourceRequestActor, resourceRequestJson, resourceResponse, resourceResponseError } from '../http';

type ResourceParams = { params: Promise<{ resourceRef: string }> };

export async function GET(request: Request, context: ResourceParams) {
  try {
    const actor = await resourceRequestActor(request);
    if (actor instanceof NextResponse) return actor;
    const { resourceRef } = await context.params;
    return resourceResponse({ resource: await inspectCapabilityResource(actor, resourceRef) });
  } catch (error) { return resourceResponseError(error); }
}

export async function POST(request: Request, context: ResourceParams) {
  try {
    const actor = await resourceRequestActor(request);
    if (actor instanceof NextResponse) return actor;
    const { resourceRef } = await context.params;
    const input = await resourceRequestJson(request);
    return resourceResponse({ resource: await configureCapabilityResource(actor, resourceRef, input as CapabilityResourceConfiguration) });
  } catch (error) { return resourceResponseError(error); }
}

export async function PATCH(request: Request, context: ResourceParams) {
  try {
    const actor = await resourceRequestActor(request);
    if (actor instanceof NextResponse) return actor;
    const { resourceRef } = await context.params;
    const input = await resourceRequestJson(request);
    return resourceResponse({ resource: await updateCapabilityResource(actor, resourceRef, input as CapabilityResourceMutation) });
  } catch (error) { return resourceResponseError(error); }
}
