import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { getPersona, updatePersona, deletePersona, reorderPersonaImages } from '@/app/lib/integrations/studio-persona-service';
import { StudioServiceError } from '@/app/lib/integrations/studio-errors';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: _request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  const persona = await getPersona(id, session.user.id);
  if (!persona) {
    return NextResponse.json({ success: false, error: 'Persona not found' }, { status: 404 });
  }
  return NextResponse.json({ success: true, persona });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  let body: { name?: string; description?: string; imageOrder?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }
  try {
    if (body.name !== undefined || body.description !== undefined) {
      await updatePersona(id, session.user.id, {
        name: body.name?.trim(),
        description: body.description?.trim(),
      });
      if (body.imageOrder && Array.isArray(body.imageOrder)) {
        await reorderPersonaImages(id, session.user.id, body.imageOrder);
      }
      const refreshed = await getPersona(id, session.user.id);
      return NextResponse.json({ success: true, persona: refreshed });
    }
    if (body.imageOrder && Array.isArray(body.imageOrder)) {
      await reorderPersonaImages(id, session.user.id, body.imageOrder);
      const refreshed = await getPersona(id, session.user.id);
      return NextResponse.json({ success: true, persona: refreshed });
    }
    const refreshed = await getPersona(id, session.user.id);
    return NextResponse.json({ success: true, persona: refreshed });
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
  const session = await auth.api.getSession({ headers: _request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  try {
    const result = await deletePersona(id, session.user.id);
    return NextResponse.json({ success: result.success, warnings: result.warnings });
  } catch (err) {
    if (err instanceof StudioServiceError) {
      const status = err.code === 'NOT_FOUND' ? 404 : 400;
      return NextResponse.json({ success: false, error: err.userMessage }, { status });
    }
    throw err;
  }
}
