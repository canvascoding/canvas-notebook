import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { createPreset, listPresets } from '@/app/lib/integrations/studio-preset-service';
import { StudioServiceError } from '@/app/lib/integrations/studio-errors';

interface PresetRequestBody {
  name?: string;
  description?: string;
  category?: string | null;
  blocks?: Array<{
    id?: string;
    type?: string;
    label?: string;
    promptFragment?: string;
    category?: string;
    description?: string;
    thumbnailPath?: string | null;
  }>;
  tags?: string[];
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const category = request.nextUrl.searchParams.get('category') ?? undefined;
    const presets = await listPresets(session.user.id, category);
    return NextResponse.json({ success: true, presets });
  } catch (error) {
    if (error instanceof StudioServiceError) {
      return NextResponse.json({ success: false, error: error.userMessage }, { status: 400 });
    }
    console.error('[Studio Presets] GET error:', error);
    return NextResponse.json({ success: false, error: 'Failed to load presets' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  let body: PresetRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
    return NextResponse.json({ success: false, error: 'Name is required' }, { status: 400 });
  }

  if (!body.category || typeof body.category !== 'string' || body.category.trim().length === 0) {
    return NextResponse.json({ success: false, error: 'Category is required' }, { status: 400 });
  }

  if (!Array.isArray(body.blocks) || body.blocks.length === 0) {
    return NextResponse.json({ success: false, error: 'At least one block is required' }, { status: 400 });
  }

  try {
    const preset = await createPreset(session.user.id, {
      name: body.name,
      description: body.description,
      category: body.category,
      blocks: body.blocks.map((block) => ({
        id: block.id,
        type: block.type ?? '',
        label: block.label ?? '',
        promptFragment: block.promptFragment ?? '',
        category: block.category,
        description: block.description,
        thumbnailPath: block.thumbnailPath ?? null,
      })),
      tags: Array.isArray(body.tags) ? body.tags : undefined,
    });

    return NextResponse.json({ success: true, preset }, { status: 201 });
  } catch (error) {
    if (error instanceof StudioServiceError) {
      return NextResponse.json({ success: false, error: error.userMessage }, { status: 400 });
    }
    console.error('[Studio Presets] POST error:', error);
    return NextResponse.json({ success: false, error: 'Failed to create preset' }, { status: 500 });
  }
}
