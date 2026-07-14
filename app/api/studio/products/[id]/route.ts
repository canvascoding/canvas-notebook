import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { getProduct, updateProduct, deleteProduct, reorderProductImages } from '@/app/lib/integrations/studio-product-service';
import { StudioServiceError } from '@/app/lib/integrations/studio-errors';
import { requireOrganizationPermission } from '@/app/lib/organization/permissions';
import { requireStudioRequestScope } from '@/app/lib/integrations/studio-request-scope';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: _request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const studioRequest = await requireStudioRequestScope(_request, session);
  if (!studioRequest.scope) return studioRequest.response;
  const { id } = await params;
  const product = await getProduct(id, studioRequest.scope);
  if (!product) {
    return NextResponse.json({ success: false, error: 'Product not found' }, { status: 404 });
  }
  return NextResponse.json({ success: true, product });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const studioRequest = await requireStudioRequestScope(request, session, { permissions: 'canWrite' });
  if (!studioRequest.scope) return studioRequest.response;
  const { id } = await params;
  let body: { name?: string; description?: string; imageOrder?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }
  try {
    if (body.name !== undefined || body.description !== undefined) {
      await updateProduct(id, studioRequest.scope, {
        name: body.name?.trim(),
        description: body.description?.trim(),
      });
      if (body.imageOrder && Array.isArray(body.imageOrder)) {
        await reorderProductImages(id, studioRequest.scope, body.imageOrder);
      }
      const refreshed = await getProduct(id, studioRequest.scope);
      return NextResponse.json({ success: true, product: refreshed });
    }
    if (body.imageOrder && Array.isArray(body.imageOrder)) {
      await reorderProductImages(id, studioRequest.scope, body.imageOrder);
      const refreshed = await getProduct(id, studioRequest.scope);
      return NextResponse.json({ success: true, product: refreshed });
    }
    const refreshed = await getProduct(id, studioRequest.scope);
    return NextResponse.json({ success: true, product: refreshed });
  } catch (err) {
    if (err instanceof StudioServiceError) {
      const status = err.code === 'NOT_FOUND' ? 404 : 400;
      return NextResponse.json({ success: false, error: err.userMessage }, { status });
    }
    throw err;
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const studioPermission = await requireOrganizationPermission(_request, 'canDeleteStudioAssets', {
    errorMessage: 'Forbidden: Studio asset delete permission required',
  });
  if (!studioPermission.ok) return studioPermission.response;
  const studioRequest = await requireStudioRequestScope(_request, studioPermission.session, { permissions: 'canWrite' });
  if (!studioRequest.scope) return studioRequest.response;

  const { id } = await params;
  try {
    const result = await deleteProduct(id, studioRequest.scope);
    return NextResponse.json({ success: result.success, warnings: result.warnings });
  } catch (err) {
    if (err instanceof StudioServiceError) {
      const status = err.code === 'NOT_FOUND' ? 404 : 400;
      return NextResponse.json({ success: false, error: err.userMessage }, { status });
    }
    throw err;
  }
}
