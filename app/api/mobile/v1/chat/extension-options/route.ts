import { NextRequest } from 'next/server';
import { readMobileChatExtensionOptions } from '@/app/lib/mobile/extension-context-v2';
import { requireMobileScopedContext, mobileScopedError } from '@/app/lib/mobile/scoped-route-v2';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Read-only metadata POST. No Session, message or provider business call is created. */
export async function POST(request: NextRequest) {
  try {
    const context = await requireMobileScopedContext(request);
    return await readMobileChatExtensionOptions(context, request);
  } catch (error) { return mobileScopedError(error); }
}
