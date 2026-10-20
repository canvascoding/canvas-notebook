import { NextResponse } from 'next/server';
import { readCapabilityPackageIconAction } from '@/app/lib/capabilities/packages/presentation-actions';
import type { CapabilityPackageDeclaredIcon } from '@/app/lib/capabilities/packages/package-icon-image';
import { packageRequestActor, packageResponseError } from '../../http';
import { capabilityPackageQuery } from '../../routes';
import { withExtensionObservation } from '@/app/lib/plugins/extension-search-observation';

export const dynamic = 'force-dynamic';
function imageResponse(image: CapabilityPackageDeclaredIcon | null) {
  const redirect = image && 'url' in image ? image.url : undefined;
  const local = image && 'bytes' in image ? image : undefined;
  return new NextResponse(local ? new Uint8Array(local.bytes) : null, {status: redirect ? 307 : local ? 200 : 204, headers: {
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    ...(local ? {'Content-Type': local.contentType} : {}),
    ...(redirect ? {Location: redirect} : {}),
  }});
}
export async function GET(request: Request, context: {params: Promise<{resourceRef: string}>}) {
  const observed = await withExtensionObservation(() => readIcon(request, context));
  observed.result.headers.set('Server-Timing', observed.serverTiming);
  return observed.result;
}
async function readIcon(request: Request, context: {params: Promise<{resourceRef: string}>}) {
  try {
    const actor = await packageRequestActor(request);
    if (actor instanceof NextResponse) return actor;
    const resourceRef = (await context.params).resourceRef, query = capabilityPackageQuery(request, ['revision', 'childName']);
    let image: CapabilityPackageDeclaredIcon | null;
    try { image = await readCapabilityPackageIconAction(actor, resourceRef, query); }
    catch (error) {
      // An optional image can be absent in a listed legacy source. Never remap its private root or return package bytes.
      if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return imageResponse(null);
      throw error;
    }
    return imageResponse(image);
  } catch (error) { return packageResponseError(error); }
}
