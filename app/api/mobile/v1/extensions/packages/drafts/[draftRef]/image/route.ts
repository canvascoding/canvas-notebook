import { NextRequest, NextResponse } from 'next/server';
import { isCapabilityPackageError } from '@/app/lib/capabilities/packages/contracts';
import { readCapabilityPackageDraftImageAction, capabilityPackageDraftPresentationQuerySchema } from '@/app/lib/capabilities/packages/draft-presentation';
import { MOBILE_SCOPED_HEADERS, MobileScopedError, mobileScopedError, requireMobileScopedContext, revalidateMobileScopedContext } from '@/app/lib/mobile/scoped-route-v2';

export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest, route: {params: Promise<{draftRef: string}>}) {
  try {
    const context = await requireMobileScopedContext(request, ['expectedDraftRevision']);
    const query = capabilityPackageDraftPresentationQuerySchema.required().parse({expectedDraftRevision: new URL(request.url).searchParams.get('expectedDraftRevision')});
    const {draftRef} = await route.params;
    const image = await readCapabilityPackageDraftImageAction({userId: context.userId, workspaceId: context.workspaceId}, draftRef, query);
    await revalidateMobileScopedContext(context);
    return new NextResponse(new Uint8Array(image.bytes), {headers: {...MOBILE_SCOPED_HEADERS, 'Content-Type': image.contentType, 'Content-Security-Policy': "default-src 'none'; sandbox"}});
  } catch (error) {
    return mobileScopedError(isCapabilityPackageError(error) ? new MobileScopedError(error.code, 'The draft image is unavailable.', error.status) : error);
  }
}
