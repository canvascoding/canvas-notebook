import { NextResponse } from 'next/server';
import { readCapabilityPackageIconAction } from '@/app/lib/capabilities/packages/presentation-actions';
import { packageRequestActor, packageResponseError } from '../../http';
import { capabilityPackageQuery } from '../../routes';

export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: {params: Promise<{resourceRef: string}>}) {
  try {
    const actor = await packageRequestActor(request);
    if (actor instanceof NextResponse) return actor;
    const image = await readCapabilityPackageIconAction(actor, (await context.params).resourceRef,
      capabilityPackageQuery(request, ['revision', 'childName']));
    const redirect = image && 'url' in image ? image.url : undefined;
    const local = image && 'bytes' in image ? image : undefined;
    return new NextResponse(local ? new Uint8Array(local.bytes) : null, {status: redirect ? 307 : local ? 200 : 204, headers: {
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      ...(local ? {'Content-Type': local.contentType} : {}),
      ...(redirect ? {Location: redirect} : {}),
    }});
  } catch (error) { return packageResponseError(error); }
}
