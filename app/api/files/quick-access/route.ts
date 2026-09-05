import { NextRequest } from 'next/server';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';
import { applyRateLimit, jsonError, jsonServerError, jsonSuccess } from '@/app/lib/api/route-helpers';
import { getCachedFileReferenceEntries } from '@/app/lib/filesystem/file-reference-cache';
import { getFileStats } from '@/app/lib/filesystem/workspace-files';
import { enrichWorkspaceFileNodes } from '@/app/lib/files/workspace-file-metadata';
import { readFileVisits, recordFileVisit } from '@/app/lib/files/file-visit-storage';
import { selectQuickAccessFiles, type QuickAccessView } from '@/app/lib/files/quick-access';
import { normalizeWorkspacePathParam } from '@/app/lib/files/path-utils';

const VIEWS = new Set(['recent', 'favorites', 'frequent', 'all']);

export async function GET(request: NextRequest) {
  const result = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (result.response) return result.response;
  const limited = applyRateLimit(request, { limit: 120, windowMs: 60_000, keyPrefix: 'file-quick-access' });
  if (limited) return limited;
  const params = request.nextUrl.searchParams;
  const view = params.get('view') || 'recent';
  const limit = Number(params.get('limit') || 6);
  if (!VIEWS.has(view) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    return jsonError('Invalid quick access view or limit', 400);
  }
  try {
    const [references, visits] = await Promise.all([
      getCachedFileReferenceEntries(false, workspaceFileOptions(result.workspace)),
      readFileVisits(result.session.user.id, result.workspace.workspaceId),
    ]);
    const nodes = await enrichWorkspaceFileNodes({
      nodes: references, workspace: result.workspace, userId: result.session.user.id,
    });
    const query = (params.get('q') || '').trim().slice(0, 256);
    let activeView = view as QuickAccessView;
    let data = selectQuickAccessFiles(nodes, visits, activeView, query, limit);
    if (activeView === 'recent' && !query && data.total === 0 && data.workspaceFileCount > 0) {
      activeView = 'all';
      data = selectQuickAccessFiles(nodes, visits, activeView, '', limit);
    }
    const favorites = view === 'recent' && !query
      ? selectQuickAccessFiles(nodes, visits, 'favorites', '', 3).files
      : [];
    return jsonSuccess({ data: { ...data, favorites, view: activeView } }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return jsonServerError('[Quick access]', error, 'Failed to load quick access files');
  }
}

export async function POST(request: NextRequest) {
  const result = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (result.response) return result.response;
  const limited = applyRateLimit(request, { limit: 120, windowMs: 60_000, keyPrefix: 'file-visits' });
  if (limited) return limited;
  const body = await request.json().catch(() => null);
  const path = typeof body?.path === 'string' ? normalizeWorkspacePathParam(body.path) : null;
  if (!path || path.length > 4096) return jsonError('A valid file path is required', 400);
  try {
    const stats = await getFileStats(path, workspaceFileOptions(result.workspace));
    if (!stats.isFile) return jsonError('Only files can be recorded', 400);
    await recordFileVisit(result.session.user.id, result.workspace.workspaceId, path);
    return jsonSuccess();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return jsonError('File not found', 404);
    return jsonServerError('[File visit]', error, 'Failed to record file visit');
  }
}
