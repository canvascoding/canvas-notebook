import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { listStyles, createStyle } from '@/app/lib/integrations/studio-style-service';
import { requireStudioRequestScope } from '@/app/lib/integrations/studio-request-scope';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const studioRequest = await requireStudioRequestScope(request, session);
  if (!studioRequest.scope) return studioRequest.response;
  const search = request.nextUrl.searchParams.get('search') ?? undefined;
  const styles = await listStyles(studioRequest.scope, search);
  return NextResponse.json({ success: true, styles });
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const studioRequest = await requireStudioRequestScope(request, session, { permissions: 'canWrite' });
  if (!studioRequest.scope) return studioRequest.response;
  let body: { name?: string; description?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
    return NextResponse.json({ success: false, error: 'Name is required' }, { status: 400 });
  }
  const style = await createStyle(studioRequest.scope, {
    name: body.name.trim(),
    description: body.description?.trim(),
  });
  return NextResponse.json({ success: true, style }, { status: 201 });
}
