import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { readDictationAvailability } from '@/app/lib/dictation/service';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  try {
    const status = await readDictationAvailability();
    return NextResponse.json({ success: true, data: status }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ success: false, error: 'Failed to read dictation status.' }, { status: 503 });
  }
}
