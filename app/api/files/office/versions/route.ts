import { NextRequest } from 'next/server';
import { applyRateLimit, jsonError, jsonServerError, jsonSuccess } from '@/app/lib/api/route-helpers';
import { isDocxPath } from '@/app/lib/files/collaboration-policy';
import { OfficeJournalError } from '@/app/lib/office/document-journal';
import { readOfficePathHistory } from '@/app/lib/office/document-versions';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

/** Recovery reads stay inside the authorized document lineage. Restoring is a normal conditional save. */
export async function GET(request: NextRequest) {
  const context = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (context.response) return context.response;
  const limited = applyRateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'office-versions' });
  if (limited) return limited;
  try {
    const path = request.nextUrl.searchParams.get('path');
    if (!path || !isDocxPath(path)) return jsonError('A DOCX path is required', 400);
    const data = await readOfficePathHistory(context.workspace, path,
      request.nextUrl.searchParams.get('lineageId'), request.nextUrl.searchParams.get('contentHash'));
    return jsonSuccess({ data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof OfficeJournalError) return jsonError(error.message, error.status, { code: error.code });
    return jsonServerError('[API] Office recovery error:', error, 'Failed to read document recovery history');
  }
}
