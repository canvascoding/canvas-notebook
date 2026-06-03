import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { getStudioProviderConfig } from '@/app/lib/integrations/studio-config';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const config = await getStudioProviderConfig();
  return NextResponse.json({ success: true, config });
}
