import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { auth } from '@/app/lib/auth';
import { db } from '@/app/lib/db';
import { studioGenerationOutputs, studioGenerations } from '@/app/lib/db/schema';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; outId: string }> },
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { id, outId } = await params;

  let body: { isFavorite?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  if (typeof body.isFavorite !== 'boolean') {
    return NextResponse.json({ success: false, error: 'isFavorite must be a boolean' }, { status: 400 });
  }

  try {
    const [existing] = await db
      .select({ id: studioGenerationOutputs.id })
      .from(studioGenerationOutputs)
      .innerJoin(studioGenerations, eq(studioGenerationOutputs.generationId, studioGenerations.id))
      .where(and(
        eq(studioGenerationOutputs.id, outId),
        eq(studioGenerationOutputs.generationId, id),
        eq(studioGenerations.userId, session.user.id),
      ))
      .limit(1);

    if (!existing) {
      return NextResponse.json({ success: false, error: 'Output not found' }, { status: 404 });
    }

    const [updated] = await db
      .update(studioGenerationOutputs)
      .set({ isFavorite: body.isFavorite })
      .where(eq(studioGenerationOutputs.id, outId))
      .returning();

    return NextResponse.json({ success: true, output: updated });
  } catch (error) {
    console.error('[Studio Output Patch] Error:', error);
    return NextResponse.json({ success: false, error: 'Failed to update output' }, { status: 500 });
  }
}
