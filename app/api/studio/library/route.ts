import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { listProducts } from '@/app/lib/integrations/studio-product-service';
import { listPersonas } from '@/app/lib/integrations/studio-persona-service';
import { listStudioGenerations } from '@/app/lib/integrations/studio-generation-service';
import { listPresets } from '@/app/lib/integrations/studio-preset-service';
import { requireStudioRequestScope } from '@/app/lib/integrations/studio-request-scope';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const studioRequest = await requireStudioRequestScope(request, session);
  if (!studioRequest.scope) return studioRequest.response;

  try {
    const [products, personas, presets, generationResult] = await Promise.all([
      listProducts(studioRequest.scope),
      listPersonas(studioRequest.scope),
      listPresets(studioRequest.scope),
      listStudioGenerations(studioRequest.scope),
    ]);

    return NextResponse.json({
      success: true,
      products,
      personas,
      presets,
      generations: generationResult.generations,
      creators: generationResult.creators,
    });
  } catch (error) {
    console.error('[Studio Library] Error:', error);
    return NextResponse.json({ success: false, error: 'Failed to load library' }, { status: 500 });
  }
}
