import { NextResponse } from 'next/server';
import { readCapabilityPackageDraftImageAction } from '@/app/lib/capabilities/packages/draft-presentation';
import { packageRequestActor, packageResponseError } from '../../../http';
import { capabilityPackageQuery } from '../../../routes';

export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{draftRef: string}> }) {
  try {
    const actor = await packageRequestActor(request);
    if (actor instanceof NextResponse) return actor;
    const image = await readCapabilityPackageDraftImageAction(actor, (await context.params).draftRef,
      capabilityPackageQuery(request, ['expectedDraftRevision']) as { expectedDraftRevision: number });
    return new NextResponse(new Uint8Array(image.bytes), { headers: { 'Content-Type': image.contentType, 'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" } });
  } catch (error) { return packageResponseError(error); }
}
