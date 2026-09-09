import { NextRequest } from 'next/server';
import { fileGuestService, FileGuestError } from '@/app/lib/file-guests/service';
import { fileGuestCookieName, isFileGuestId } from '@/app/lib/file-guests/types';
import { assertFileGuestOrigin, fileGuestErrorResponse, fileGuestJson, fileGuestRateLimit, guestRequestToken, readFileGuestBody } from '@/app/lib/file-guests/http';
import { fileGuestCheckpoint, fileGuestCollaborationSession } from '@/app/lib/file-guests/collaboration';

export async function POST(request: NextRequest, context: { params: Promise<{ id: string; action: string }> }) {
  try {
    assertFileGuestOrigin(request);
    const { id, action } = await context.params;
    if (!isFileGuestId(id) || !['challenge', 'verify', 'session', 'checkpoint', 'logout'].includes(action)) throw new FileGuestError('Dateizugang nicht gefunden.', 404);
    const limited = fileGuestRateLimit(request, action);
    if (!limited.ok) return limited.response;
    const body = await readFileGuestBody(request);
    const token = guestRequestToken(request, id);
    if (action === 'challenge') {
      await fileGuestService.challenge(id);
      return fileGuestJson({ success: true, message: 'Der Code wurde an die eingeladene E-Mail-Adresse gesendet.' });
    }
    if (action === 'verify') {
      const verified = await fileGuestService.verify(id, String(body.code || ''), String(body.displayName || ''));
      const response = fileGuestJson({ success: true });
      response.cookies.set(fileGuestCookieName(id), verified.token, { httpOnly: true, secure: process.env.AUTH_COOKIE_SECURE === 'true'
        || (process.env.BETTER_AUTH_BASE_URL || process.env.BASE_URL || '').startsWith('https:'),
      sameSite: 'strict', path: '/', expires: verified.expiresAt });
      return response;
    }
    if (action === 'logout') {
      await fileGuestService.logout(id, token);
      const response = fileGuestJson({ success: true });
      response.cookies.set(fileGuestCookieName(id), '', { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 0 });
      return response;
    }
    if (action === 'session') return fileGuestJson(await fileGuestCollaborationSession(id, token));
    return fileGuestJson(await fileGuestCheckpoint(id, token, String(body.token || ''), String(body.stateVector || ''), body.stateProof));
  } catch (error) { return fileGuestErrorResponse(error); }
}
