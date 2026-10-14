import { NextRequest } from 'next/server';
import { readMobileExtensionIcon } from '@/app/lib/mobile/extension-icons-v2';
import { isCapabilityPackageError } from '@/app/lib/capabilities/packages/contracts';
import { McpAccessError } from '@/app/lib/mcp/access';
import { requireMobileScopedContext, mobileScopedError, MobileScopedError } from '@/app/lib/mobile/scoped-route-v2';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const context = await requireMobileScopedContext(request, ['kind', 'resourceRef', 'publishedRevisionRef', 'checksum',
      'childRelativeRoot', 'revision', 'childName', 'selectionId', 'binding']);
    return await readMobileExtensionIcon(context, request);
  } catch (error) {
    return mobileScopedError(isCapabilityPackageError(error) || error instanceof McpAccessError
      ? new MobileScopedError(error.code, 'The source image is unavailable.', error.status) : error);
  }
}
