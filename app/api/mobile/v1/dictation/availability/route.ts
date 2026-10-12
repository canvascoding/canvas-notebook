import { NextRequest, NextResponse } from 'next/server';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { mobileDictationHeaders, mobileDictationLimits, mobileDictationErrorResponse, readMobileDictationAvailability } from '@/app/lib/mobile/dictation';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const scope = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (scope.response) return scope.response;
  const limited = rateLimit(request, { limit: 40, windowMs: 60_000, keyPrefix: `mobile-dictation-status:${scope.session.user.id}` });
  if (!limited.ok) return limited.response;
  try {
    return NextResponse.json({ success: true, contractVersion: 1, workspaceId: scope.workspace.workspaceId,
      checkedAt: Date.now(), availability: await readMobileDictationAvailability(), limits: mobileDictationLimits }, { headers: mobileDictationHeaders });
  } catch (error) { return mobileDictationErrorResponse(error, request.signal); }
}
