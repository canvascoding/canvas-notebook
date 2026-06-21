import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { auth } from '@/app/lib/auth';
import { db } from '@/app/lib/db';
import { studioGenerationOutputs, studioGenerations } from '@/app/lib/db/schema';
import { deleteStudioOutput, getStudioOutputForUser } from '@/app/lib/integrations/studio-generation-service';
import { requireOrganizationPermission } from '@/app/lib/organization/permissions';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; outId: string }> },
) {
  const studioPermission = await requireOrganizationPermission(request, 'canDeleteStudioAssets', {
    errorMessage: 'Forbidden: Studio asset delete permission required',
  });
  if (!studioPermission.ok) return studioPermission.response;

  const { id: _id, outId } = await params;

  try {
    const result = await deleteStudioOutput(outId, studioPermission.session.user.id);
    await recordAuditEvent({
      organizationId: studioPermission.state.organizationId,
      userId: studioPermission.session.user.id,
      source: 'studio',
      eventType: 'studio',
      entityType: 'studio_generation_output',
      entityId: outId,
      action: 'studio_output.delete',
      status: 'success',
      summary: `Studio output ${outId} deleted.`,
      metadata: {
        generationId: _id,
        generationDeleted: result.generationDeleted,
        permissionRole: studioPermission.permission.role,
      },
    });
    return NextResponse.json({ success: true, generationDeleted: result.generationDeleted });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete output';
    const status = message.includes('not found') ? 404 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}

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
    const existing = await getStudioOutputForUser(outId, session.user.id);

    if (!existing || existing.generationId !== id) {
      return NextResponse.json({ success: false, error: 'Output not found' }, { status: 404 });
    }

    const [ownedOutput] = await db
      .select({ id: studioGenerationOutputs.id })
      .from(studioGenerationOutputs)
      .innerJoin(studioGenerations, eq(studioGenerationOutputs.generationId, studioGenerations.id))
      .where(and(
        eq(studioGenerationOutputs.id, outId),
        eq(studioGenerations.id, id),
        eq(studioGenerations.userId, session.user.id),
      ))
      .limit(1);

    if (!ownedOutput) {
      return NextResponse.json({ success: false, error: 'Output not found' }, { status: 404 });
    }

    const [updated] = await db
      .update(studioGenerationOutputs)
      .set({ isFavorite: body.isFavorite })
      .where(eq(studioGenerationOutputs.id, outId))
      .returning();
    await recordAuditEvent({
      organizationId: updated.organizationId,
      workspaceId: updated.workspaceId,
      userId: session.user.id,
      source: 'studio',
      eventType: 'studio',
      entityType: 'studio_generation_output',
      entityId: outId,
      action: 'studio_output.favorite.update',
      status: 'success',
      summary: `Studio output ${outId} favorite state updated.`,
      metadata: {
        generationId: id,
        isFavorite: body.isFavorite,
      },
    });

    return NextResponse.json({ success: true, output: updated });
  } catch (error) {
    console.error('[Studio Output Patch] Error:', error);
    return NextResponse.json({ success: false, error: 'Failed to update output' }, { status: 500 });
  }
}
