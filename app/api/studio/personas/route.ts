import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { listPersonas, createPersona } from '@/app/lib/integrations/studio-persona-service';

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const search = request.nextUrl.searchParams.get('search') ?? undefined;
  const personas = await listPersonas(session.user.id, search);
  return NextResponse.json({ success: true, personas });
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  let body: { name?: string; description?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
    return NextResponse.json({ success: false, error: 'Name is required' }, { status: 400 });
  }
  const persona = await createPersona(session.user.id, {
    name: body.name.trim(),
    description: body.description?.trim(),
  });
  return NextResponse.json({ success: true, persona }, { status: 201 });
}