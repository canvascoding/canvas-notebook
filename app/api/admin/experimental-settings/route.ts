import { NextRequest, NextResponse } from 'next/server';

import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { readDocumentReviewAvailability } from '@/app/lib/document-review-availability';
import { setDocumentReviewEnabled } from '@/app/lib/server-settings';

let pendingUpdate: Promise<unknown> = Promise.resolve();

export async function PATCH(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;
  const body = await request.json().catch(() => null);
  if (!body || typeof body.documentReviewEnabled !== 'boolean') {
    return NextResponse.json({ error: 'documentReviewEnabled must be a boolean.' }, { status: 400 });
  }
  try {
    const update = pendingUpdate.then(async () => {
      await setDocumentReviewEnabled(admin.session.user.id, body.documentReviewEnabled);
      return readDocumentReviewAvailability();
    });
    pendingUpdate = update.catch(() => undefined);
    const data = await update;
    return NextResponse.json({ success: true, data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[Experimental settings] Update failed:', error);
    return NextResponse.json({ success: false, error: 'Failed to apply experimental settings.', data: readDocumentReviewAvailability() }, { status: 503 });
  }
}
