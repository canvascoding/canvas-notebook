import { NextRequest, NextResponse } from 'next/server';

import { loadAiCatalogDiscovery } from '@/app/lib/agent-runtime-policy/catalog-discovery';
import {
  catalogErrorResponse,
  parseAiCatalogUpdate,
  replaceAiAppRuntimeCatalog,
} from '@/app/lib/agent-runtime-policy/catalog-service';
import { readAppRuntimeCatalog } from '@/app/lib/agent-runtime-policy/catalog-store';
import type { AiCatalogUpdate, AiProviderSafeConfig } from '@/app/lib/agent-runtime-policy/types';
import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import {
  isOrganizationAdminLike,
  readOrganizationPermissionForUser,
} from '@/app/lib/organization/permissions';
import { rateLimit } from '@/app/lib/utils/rate-limit';

async function requireCatalogAdmin(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin;

  const state = await readOrganizationPermissionForUser(admin.session.user.id);
  if (!state.configured || !state.organizationId) {
    return {
      ok: false as const,
      response: NextResponse.json(
        {
          success: false,
          code: 'ORGANIZATION_SETUP_REQUIRED',
          error: 'Complete the app setup before configuring AI providers and models.',
        },
        { status: 409 },
      ),
    };
  }
  if (!isOrganizationAdminLike(state.permission)) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { success: false, code: 'ADMIN_REQUIRED', error: 'Organization admin permission required.' },
        { status: 403 },
      ),
    };
  }

  return {
    ok: true as const,
    session: admin.session,
    state,
    organizationId: state.organizationId,
  };
}

function groupProviderConfigs(update: AiCatalogUpdate): Record<string, AiProviderSafeConfig[]> {
  const grouped: Record<string, AiProviderSafeConfig[]> = {};
  for (const provider of update.providers) {
    (grouped[provider.providerId] ??= []).push(provider.config);
  }
  return grouped;
}

export async function GET(request: NextRequest) {
  const admin = await requireCatalogAdmin(request);
  if (!admin.ok) return admin.response;

  const limited = rateLimit(request, {
    limit: 120,
    windowMs: 60_000,
    keyPrefix: `agent-runtime-catalog-get:${admin.session.user.id}`,
  });
  if (!limited.ok) return limited.response;

  try {
    const catalog = await readAppRuntimeCatalog(admin.organizationId);
    const configs: Record<string, AiProviderSafeConfig[]> = {};
    for (const provider of catalog.providers) {
      (configs[provider.providerId] ??= []).push(provider.config);
    }
    const discovery = await loadAiCatalogDiscovery(configs);

    return NextResponse.json({
      success: true,
      data: { catalog, discovery },
    });
  } catch (error) {
    console.error('[admin/agent-runtime/catalog] Failed to read catalog.', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    return NextResponse.json(
      { success: false, code: 'CATALOG_READ_FAILED', error: 'Failed to read the AI runtime catalog.' },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  const admin = await requireCatalogAdmin(request);
  if (!admin.ok) return admin.response;

  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: `agent-runtime-catalog-put:${admin.session.user.id}`,
  });
  if (!limited.ok) return limited.response;

  try {
    const payload = await request.json().catch(() => null);
    const update = parseAiCatalogUpdate(payload);
    const discovery = await loadAiCatalogDiscovery(groupProviderConfigs(update));
    const catalog = await replaceAiAppRuntimeCatalog({
      organizationId: admin.organizationId,
      actorUserId: admin.session.user.id,
      update,
      discovery,
    });

    await recordAuditEvent({
      organizationId: admin.organizationId,
      userId: admin.session.user.id,
      source: 'agent-runtime',
      eventType: 'admin',
      entityType: 'ai_runtime_catalog',
      entityId: admin.organizationId,
      action: 'ai_runtime_catalog.replace',
      status: 'success',
      summary: 'AI provider and model catalog updated.',
      metadata: {
        revision: catalog.revision,
        providers: catalog.providers.map((provider) => ({
          providerInstallationId: provider.installationId,
          providerId: provider.providerId,
          credentialScope: provider.credentialScope,
          enabled: provider.enabled,
          modelCount: provider.models.length,
        })),
        defaultSelection: catalog.defaultSelection,
      },
    });

    return NextResponse.json({ success: true, data: { catalog, discovery } });
  } catch (error) {
    const response = catalogErrorResponse(error);
    await recordAuditEvent({
      organizationId: admin.organizationId,
      userId: admin.session.user.id,
      source: 'agent-runtime',
      eventType: 'admin',
      entityType: 'ai_runtime_catalog',
      entityId: admin.organizationId,
      action: 'ai_runtime_catalog.replace',
      status: response.status >= 500 ? 'error' : 'blocked',
      summary: 'AI provider and model catalog update failed.',
      metadata: { errorCode: response.code },
    });
    if (response.status >= 500) {
      console.error('[admin/agent-runtime/catalog] Failed to update catalog.', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
    }
    return NextResponse.json(
      { success: false, code: response.code, error: response.message },
      { status: response.status },
    );
  }
}
