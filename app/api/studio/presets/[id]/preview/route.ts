import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { generatePresetPreview } from '@/app/lib/integrations/studio-preset-service';
import { StudioServiceError } from '@/app/lib/integrations/studio-errors';

interface PresetPreviewRequestBody {
  provider?: string;
  model?: string;
  aspectRatio?: string;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  let body: PresetPreviewRequestBody = {};
  try {
    if (request.headers.get('content-length') !== '0') {
      body = await request.json();
    }
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    const preset = await generatePresetPreview(session.user.id, id, body);
    return NextResponse.json({
      success: true,
      preset,
      previewImagePath: preset.previewImagePath,
      previewImageUrl: preset.previewImageUrl,
    });
  } catch (error) {
    if (error instanceof StudioServiceError) {
      const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'FORBIDDEN' ? 403 : 400;
      return NextResponse.json({ success: false, error: error.userMessage }, { status });
    }
    console.error('[Studio Preset Preview] POST error:', error);
    return NextResponse.json({ success: false, error: 'Failed to generate preview' }, { status: 500 });
  }
}
