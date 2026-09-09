import { NextRequest } from 'next/server';
import { fileGuestService } from '@/app/lib/file-guests/service';
import { fileGuestErrorResponse, fileGuestJson, guestRequestToken } from '@/app/lib/file-guests/http';
import { fileGuestCollaborationSession } from '@/app/lib/file-guests/collaboration';

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const token = guestRequestToken(request, id);
    const content = await fileGuestService.content(id, token);
    const session = await fileGuestCollaborationSession(id, token);
    return fileGuestJson({ success: true, fileName: content.fileName, path: content.invitation.path,
      markdown: content.markdown, permission: content.invitation.permission, expiresAt: content.invitation.expiresAt?.toISOString() ?? null,
      assets: content.assets.map((asset) => asset.path), session });
  } catch (error) { return fileGuestErrorResponse(error); }
}
