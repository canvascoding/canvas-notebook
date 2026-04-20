import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { getStudioPresetBlockCatalog } from '@/app/lib/integrations/studio-preset-service';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const catalog = getStudioPresetBlockCatalog();
  return NextResponse.json({
    success: true,
    blockTypes: catalog.blockTypes,
    categories: catalog.categories,
  });
}
