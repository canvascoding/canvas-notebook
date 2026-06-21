import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { listProducts } from '@/app/lib/integrations/studio-product-service';
import { listPersonas } from '@/app/lib/integrations/studio-persona-service';
import { listStudioGenerations } from '@/app/lib/integrations/studio-generation-service';
import { db } from '@/app/lib/db';
import { studioPresets } from '@/app/lib/db/schema';
import { eq, or } from 'drizzle-orm';
import { resolveStudioScope } from '@/app/lib/integrations/studio-scope';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const [products, personas, generationResult] = await Promise.all([
      listProducts(session.user.id),
      listPersonas(session.user.id),
      listStudioGenerations(session.user.id),
    ]);

    const scope = resolveStudioScope(session.user.id);
    const presetVisibility = scope.organizationWide && scope.organizationId
      ? or(eq(studioPresets.userId, session.user.id), eq(studioPresets.organizationId, scope.organizationId), eq(studioPresets.isDefault, true))
      : or(eq(studioPresets.userId, session.user.id), eq(studioPresets.isDefault, true));

    const presets = await db.select({
      id: studioPresets.id,
      name: studioPresets.name,
      description: studioPresets.description,
      category: studioPresets.category,
      isDefault: studioPresets.isDefault,
    })
      .from(studioPresets)
      .where(presetVisibility);

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
