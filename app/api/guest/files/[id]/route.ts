import { NextRequest } from 'next/server';
import { parseFileGuestPermission } from '@/app/lib/file-guests/service';
import { fileGuestErrorResponse, fileGuestJson, guestRequestToken } from '@/app/lib/file-guests/http';
import { fileGuestCollaborationContent } from '@/app/lib/file-guests/collaboration';
import type { FileGuestDocumentResponse } from '@/app/lib/file-guests/content-contract';

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const token = guestRequestToken(request, id);
    const {content,session} = await fileGuestCollaborationContent(id,token);
    return fileGuestJson({ success: true, fileName: content.fileName, path: content.invitation.path,
      bootstrap: content.bootstrap, permission: parseFileGuestPermission(content.invitation.permission), expiresAt: content.invitation.expiresAt?.toISOString() ?? null,
      assets: content.assets.map((asset) => asset.path), session } satisfies FileGuestDocumentResponse);
  } catch (error) { return fileGuestErrorResponse(error); }
}
