import { NextRequest, NextResponse } from 'next/server';
import { fileGuestService } from '@/app/lib/file-guests/service';
import { FILE_GUEST_HEADERS, fileGuestErrorResponse, guestRequestToken } from '@/app/lib/file-guests/http';
import { getPublicShareMimeType } from '@/app/lib/public-sharing/public-file-shares';

export async function GET(request: NextRequest, context: { params: Promise<{ id: string; path: string[] }> }) {
  try {
    const { id, path: parts } = await context.params;
    const path = parts.join('/');
    const bytes = await fileGuestService.asset(id, guestRequestToken(request, id), path);
    return new NextResponse(new Uint8Array(bytes), { headers: { ...FILE_GUEST_HEADERS,
      'Content-Type': getPublicShareMimeType(path), 'Content-Length': String(bytes.length),
      'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin' } });
  } catch (error) { return fileGuestErrorResponse(error); }
}
