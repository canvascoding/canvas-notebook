import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import {
  assertPresetEditableByUser,
  deletePreset,
  getPreset,
  updatePreset,
} from '@/app/lib/integrations/studio-preset-service';
import { StudioServiceError } from '@/app/lib/integrations/studio-errors';

interface PresetPatchBody {
  name?: string;
  description?: string | null;
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

function canReadPreset(userId: string, preset: Awaited<ReturnType<typeof getPreset>>) {
  return Boolean(preset && (preset.isDefault || preset.userId === userId));
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const preset = await getPreset(id);
  if (!canReadPreset(session.user.id, preset)) {
    return NextResponse.json({ success: false, error: 'Preset not found' }, { status: 404 });
  }

  return NextResponse.json({ success: true, preset });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  let body: PresetPatchBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    await assertPresetEditableByUser(id, session.user.id);

    const preset = await updatePreset(id, {
      name: body.name,
      description: body.description,
      category: body.category,
      blocks: body.blocks?.map((block) => ({
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

    return NextResponse.json({ success: true, preset });
  } catch (error) {
    if (error instanceof StudioServiceError) {
      const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'FORBIDDEN' ? 403 : 400;
      return NextResponse.json({ success: false, error: error.userMessage }, { status });
    }
    console.error('[Studio Presets] PATCH error:', error);
    return NextResponse.json({ success: false, error: 'Failed to update preset' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  try {
    await assertPresetEditableByUser(id, session.user.id);
    await deletePreset(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof StudioServiceError) {
      const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'FORBIDDEN' ? 403 : 400;
      return NextResponse.json({ success: false, error: error.userMessage }, { status });
    }
    console.error('[Studio Presets] DELETE error:', error);
    return NextResponse.json({ success: false, error: 'Failed to delete preset' }, { status: 500 });
  }
}
