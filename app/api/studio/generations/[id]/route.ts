import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { getStudioGeneration, deleteStudioGeneration } from '@/app/lib/integrations/studio-generation-service';
import { StudioServiceError } from '@/app/lib/integrations/studio-errors';
import { requireOrganizationPermission } from '@/app/lib/organization/permissions';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: _request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  try {
    const generation = await getStudioGeneration(id, session.user.id);
    if (!generation) {
      return NextResponse.json({ success: false, error: 'Generation not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, generation });
  } catch (error) {
    console.error('[Studio Generation Detail] Error:', error);
    return NextResponse.json({ success: false, error: 'Failed to get generation' }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const studioPermission = await requireOrganizationPermission(_request, 'canDeleteStudioAssets', {
    errorMessage: 'Forbidden: Studio asset delete permission required',
  });
  if (!studioPermission.ok) return studioPermission.response;

  const { id } = await params;
  try {
    await deleteStudioGeneration(id, studioPermission.session.user.id);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof StudioServiceError) {
      return NextResponse.json({ success: false, error: error.userMessage }, { status: 400 });
    }
    console.error('[Studio Generation Delete] Error:', error);
    return NextResponse.json({ success: false, error: 'Failed to delete generation' }, { status: 500 });
  }
}
