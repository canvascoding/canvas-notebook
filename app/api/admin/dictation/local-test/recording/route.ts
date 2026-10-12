import { NextRequest, NextResponse } from 'next/server';
import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { readMobileDictationForm } from '@/app/lib/mobile/dictation';
import { validateDictationSettings } from '@/app/lib/dictation/settings';
import { readTranscriptionAvailability, transcribeAudio, TranscriptionServiceError } from '@/app/lib/transcription/service';

export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;
  const limited = rateLimit(request, { limit: 6, windowMs: 60_000, keyPrefix: 'dictation-local-recording-test' });
  if (!limited.ok) return limited.response;
  try {
    const form = await readMobileDictationForm(request);
    const settings = validateDictationSettings({ enabled: false, provider: 'local', model: form.get('model'), language: form.get('language') ?? 'auto' });
    const audio = form.get('audio');
    if (!(audio instanceof File)) return NextResponse.json({ success: false, error: 'Audio recording is required.' }, { status: 400 });
    const availability = await readTranscriptionAvailability(settings);
    if (!availability.available) return NextResponse.json({ success: false, error: availability.reason }, { status: 503 });
    const result = await transcribeAudio({ buffer: Buffer.from(await audio.arrayBuffer()), filename: audio.name, mimeType: audio.type, signal: request.signal }, settings);
    return NextResponse.json({ success: true, data: result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof TranscriptionServiceError ? error.message : 'The local recording test failed.',
      ...(error instanceof TranscriptionServiceError ? { code: error.code } : {}) }, { status: error instanceof TranscriptionServiceError ? error.status : 400 });
  }
}
