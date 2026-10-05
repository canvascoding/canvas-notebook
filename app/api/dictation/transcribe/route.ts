import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { MAX_DICTATION_BYTES, readDictationAvailability, transcribeDictationFile } from '@/app/lib/dictation/service';
import { readDictationSettings } from '@/app/lib/dictation/settings';
import { TranscriptionServiceError } from '@/app/lib/transcription/service';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const settings = await readDictationSettings();
  const availability = await readDictationAvailability(settings);
  if (!availability.available) {
    return NextResponse.json({ success: false, error: availability.reason || 'Dictation is unavailable.' }, { status: 503 });
  }
  const limited = rateLimit(request, { limit: 12, windowMs: 60_000, keyPrefix: `dictation:${session.user.id}` });
  if (!limited.ok) return limited.response;
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_DICTATION_BYTES + 100_000) {
    return NextResponse.json({ success: false, error: 'Audio recording is too large.' }, { status: 413 });
  }
  try {
    const form = await request.formData();
    const audio = form.get('audio');
    if (!(audio instanceof File)) {
      return NextResponse.json({ success: false, error: 'Audio recording is required.' }, { status: 400 });
    }
    const text = await transcribeDictationFile(audio, settings, request.signal);
    return NextResponse.json({ success: true, data: { text } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof TranscriptionServiceError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    }
    if (request.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      return NextResponse.json({ success: false, error: 'Transcription was cancelled.', code: 'TRANSCRIPTION_ABORTED' }, { status: 499 });
    }
    console.error('[Dictation] Transcription failed:', error);
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Transcription failed.' }, { status: 502 });
  }
}
