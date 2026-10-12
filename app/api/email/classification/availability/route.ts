import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { isAdminUser } from '@/app/lib/admin-auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { readEmailClassificationAvailability } from '@/app/lib/email/classification/admin-service';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401, headers });
  const limited = rateLimit(request, { limit: 90, windowMs: 60_000, keyPrefix: 'email-classification-availability', verifiedUserId: session.user.id });
  if (!limited.ok) { limited.response.headers.set('Cache-Control', headers['Cache-Control']); return limited.response; }
  try {
    const availability = await readEmailClassificationAvailability();
    return NextResponse.json({ success: true, data: {
      enabled: availability.enabled, available: availability.available, revision: availability.revision,
      defaultMode: availability.defaultMode, reason: availability.reason, canConfigure: isAdminUser(session.user),
    } }, { headers });
  } catch {
    return NextResponse.json({ success: false, code: 'CLASSIFICATION_STATUS_UNAVAILABLE', error: 'Email classification status is unavailable.' }, { status: 503, headers });
  }
}
