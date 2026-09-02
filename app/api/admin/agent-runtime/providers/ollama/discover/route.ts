import { NextRequest, NextResponse } from 'next/server';

import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import {
  discoverOllamaModels,
  OllamaDiscoveryError,
} from '@/app/lib/agent-runtime-policy/ollama-discovery-service';
import { normalizeOllamaServerUrl, OllamaServerUrlError } from '@/app/lib/agent-runtime-policy/ollama-url';
import { isOrganizationAdminLike, readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { rateLimit } from '@/app/lib/utils/rate-limit';

type DiscoveryPayload = {
  serverUrl?: unknown;
  apiKey?: unknown;
};

export async function POST(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;

  const state = await readOrganizationPermissionForUser(admin.session.user.id);
  if (!state.configured || !state.organizationId) {
    return NextResponse.json(
      { success: false, code: 'ORGANIZATION_SETUP_REQUIRED', error: 'Complete the app setup before discovering Ollama models.' },
      { status: 409 },
    );
  }
  if (!isOrganizationAdminLike(state.permission)) {
    return NextResponse.json(
      { success: false, code: 'ADMIN_REQUIRED', error: 'Organization admin permission required.' },
      { status: 403 },
    );
  }
  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: `agent-runtime-ollama-discovery:${admin.session.user.id}`,
  });
  if (!limited.ok) return limited.response;

  try {
    const payload = await request.json().catch(() => null) as DiscoveryPayload | null;
    if (!payload || typeof payload.serverUrl !== 'string') {
      return NextResponse.json(
        { success: false, code: 'INVALID_OLLAMA_URL', error: 'An Ollama server URL is required.' },
        { status: 400 },
      );
    }
    if (payload.apiKey !== undefined && (typeof payload.apiKey !== 'string' || payload.apiKey.length > 4096)) {
      return NextResponse.json(
        { success: false, code: 'INVALID_OLLAMA_API_KEY', error: 'The Ollama API key is invalid.' },
        { status: 400 },
      );
    }
    const serverUrl = normalizeOllamaServerUrl(payload.serverUrl);
    const models = await discoverOllamaModels({
      serverUrl,
      apiKey: typeof payload.apiKey === 'string' ? payload.apiKey : undefined,
      signal: request.signal,
    });
    return NextResponse.json({ success: true, data: { serverUrl, models } });
  } catch (error) {
    if (error instanceof OllamaServerUrlError) {
      return NextResponse.json(
        { success: false, code: 'INVALID_OLLAMA_URL', error: error.message },
        { status: 400 },
      );
    }
    if (error instanceof OllamaDiscoveryError) {
      return NextResponse.json(
        { success: false, code: error.code, error: error.message },
        { status: error.status },
      );
    }
    console.error('[admin/agent-runtime/providers/ollama/discover] Discovery failed.', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    return NextResponse.json(
      { success: false, code: 'OLLAMA_DISCOVERY_FAILED', error: 'Could not discover Ollama models.' },
      { status: 500 },
    );
  }
}
