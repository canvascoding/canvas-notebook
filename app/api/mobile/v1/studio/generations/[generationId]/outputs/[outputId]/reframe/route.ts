import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  createAspectRatioPreview,
  getAspectRatioModelOptions,
  saveAspectRatioEdit,
  type AspectRatioMode,
  type AspectRatioProvider,
} from '@/app/lib/integrations/studio-aspect-ratio-service';
import { resolveMobileStudioReframeFrame } from '@/app/lib/mobile/studio-reframe';
import { requireStudioRequestScope } from '@/app/lib/integrations/studio-request-scope';
import { MobileStudioError, resolveMobileStudioOutput } from '@/app/lib/mobile/studio';
import { mobileStudioErrorResponse, mobileStudioResponseHeaders } from '@/app/lib/mobile/studio-route';

const RATIOS = ['1:1', '4:5', '3:4', '4:3', '16:9', '9:16', '3:2', '2:3'] as const;

function ratioValue(value: unknown): { label: typeof RATIOS[number]; value: number } {
  if (typeof value !== 'string' || !RATIOS.includes(value as typeof RATIOS[number])) throw new MobileStudioError('Aspect ratio is not supported.', 400, 'INVALID_ASPECT_RATIO');
  const [width, height] = value.split(':').map(Number);
  return { label: value as typeof RATIOS[number], value: width / height };
}

function targetSize(targetRatio: number) {
  return targetRatio >= 1
    ? { targetWidth: 1536, targetHeight: Math.max(64, Math.round(1536 / targetRatio)) }
    : { targetWidth: Math.max(64, Math.round(1536 * targetRatio)), targetHeight: 1536 };
}

export async function POST(request: NextRequest, context: { params: Promise<{ generationId: string; outputId: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401, headers: mobileStudioResponseHeaders });
  const studioRequest = await requireStudioRequestScope(request, session, { permissions: 'canWrite' });
  if (!studioRequest.scope) return studioRequest.response;
  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const mode: AspectRatioMode = body?.mode === 'ai_extend' ? 'ai_extend' : 'crop';
    const provider: AspectRatioProvider = body?.provider === 'openai' ? 'openai' : 'gemini';
    const ratio = ratioValue(body?.aspectRatio);
    const { generationId, outputId } = await context.params;
    const output = await resolveMobileStudioOutput({ scope: studioRequest.scope, outputId });
    if (output.generationId !== generationId || output.type !== 'image' || !output.width || !output.height) throw new MobileStudioError('Image output dimensions are unavailable.', 400, 'OUTPUT_DIMENSIONS_UNAVAILABLE');
    const providerOptions = getAspectRatioModelOptions().find((entry) => entry?.id === provider);
    const model = providerOptions?.models[0]?.id;
    if (mode === 'ai_extend' && !model) throw new MobileStudioError('Image extension provider is unavailable.', 409, 'PROVIDER_UNAVAILABLE');
    const preview = await createAspectRatioPreview({
      sourcePath: output.filePath,
      frame: resolveMobileStudioReframeFrame({
        frame: body?.frame,
        mode,
        sourceWidth: output.width,
        sourceHeight: output.height,
        targetRatio: ratio.value,
      }),
      mode,
      aspectRatio: ratio.label,
      ...targetSize(ratio.value),
      provider,
      model,
      quality: 'auto',
      outputFormat: 'png',
      background: 'auto',
    }, studioRequest.scope, { userId: session.user.id });
    const saved = await saveAspectRatioEdit({
      previewPath: preview.path,
      action: 'keep_edit',
      sourcePath: output.filePath,
      aspectRatio: ratio.label,
      mode: preview.mode,
      provider,
      model,
    }, studioRequest.scope);
    return NextResponse.json({ success: true, generation: { id: saved.generationId, outputId: saved.outputId } }, { status: 201, headers: mobileStudioResponseHeaders });
  } catch (error) { return mobileStudioErrorResponse(error, '[API] Mobile Studio reframe failed:'); }
}
