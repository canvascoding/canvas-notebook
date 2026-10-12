import { NextRequest, NextResponse } from 'next/server';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { readDictationSettings } from '@/app/lib/dictation/settings';
import { readDictationAvailability, transcribeDictationFile } from '@/app/lib/dictation/service';
import { TranscriptionServiceError } from '@/app/lib/transcription/service';
import { MAX_MOBILE_DICTATION_TEXT_BYTES, mobileDictationHeaders, mobileDictationLimits, mobileDictationErrorResponse, readMobileDictationForm } from '@/app/lib/mobile/dictation';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const scope = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (scope.response) return scope.response;
  // Share the web microphone quota; changing transports cannot bypass it.
  const limited = rateLimit(request, { limit: 12, windowMs: 60_000, keyPrefix: `dictation:${scope.session.user.id}` });
  if (!limited.ok) return limited.response;
  try {
    const settings = await readDictationSettings();
    const availability = await readDictationAvailability(settings);
    if (!availability.available) throw new TranscriptionServiceError(availability.reason || 'Dictation is disabled.', 'DICTATION_UNAVAILABLE', 503);
    const form = await readMobileDictationForm(request);
    if (form.get('contractVersion') !== '1') throw new TranscriptionServiceError('Dictation contract version 1 is required.', 'INVALID_DICTATION_CONTRACT', 400);
    const audio = form.get('audio');
    if (!(audio instanceof File) || !mobileDictationLimits.acceptedMimeTypes.includes(audio.type.split(';', 1)[0].toLowerCase())) {
      throw new TranscriptionServiceError('A supported audio recording is required.', 'UNSUPPORTED_AUDIO_FORMAT', 400);
    }
    const text = await transcribeDictationFile(audio, settings, request.signal);
    if (Buffer.byteLength(text, 'utf8') > MAX_MOBILE_DICTATION_TEXT_BYTES) throw new TranscriptionServiceError('The transcript is too large for the mobile dictation contract.', 'TRANSCRIPT_TOO_LARGE', 413);
    return NextResponse.json({ success: true, contractVersion: 1, workspaceId: scope.workspace.workspaceId,
      checkedAt: Date.now(), data: { text } }, { headers: mobileDictationHeaders });
  } catch (error) { return mobileDictationErrorResponse(error, request.signal); }
}
