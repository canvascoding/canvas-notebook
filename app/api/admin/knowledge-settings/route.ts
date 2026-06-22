import { NextRequest, NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import {
  readKnowledgeOperationalLogs,
  readKnowledgeParsingSettings,
  resolveKnowledgeResourceStatus,
  updateKnowledgeParsingSettings,
} from '@/app/lib/knowledge/settings-service';
import { requireOrganizationPermission } from '@/app/lib/organization/permissions';
import { rateLimit } from '@/app/lib/utils/rate-limit';

type PatchPayload = {
  settings?: Record<string, unknown>;
};

const SETTING_KEYS = [
  'knowledgeAutoIngestionEnabled',
  'heavyDocumentParsingEnabled',
  'doclingEnabled',
  'ocrEnabled',
  'embeddingIndexingEnabled',
  'remoteParsingEnabled',
  'maxConcurrentHeavyJobs',
  'maxDocumentSizeMb',
  'maxPages',
  'maxOcrPages',
  'perFileTimeoutSeconds',
  'minimumFreeMemoryMb',
] as const;
const POLICY_BLOCK_ERROR_PREFIX = 'Knowledge settings update blocked:';

function extractSettingsPatch(payload: PatchPayload): Record<string, unknown> {
  const source = payload.settings && typeof payload.settings === 'object' && !Array.isArray(payload.settings)
    ? payload.settings
    : {};
  const patch: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    if (key in source) {
      patch[key] = source[key];
    }
  }
  return patch;
}

export async function GET(request: NextRequest) {
  const admin = await requireOrganizationPermission(request, 'canEnableKnowledge', {
    errorMessage: 'Only users with Knowledge administration permission can view Knowledge settings.',
  });
  if (!admin.ok) return admin.response;

  const limited = rateLimit(request, {
    limit: 120,
    windowMs: 60_000,
    keyPrefix: `knowledge-settings-get:${admin.session.user.id}`,
  });
  if (!limited.ok) return limited.response;

  const { settings, storage } = await readKnowledgeParsingSettings(admin.state);
  const resourceStatus = await resolveKnowledgeResourceStatus(settings, admin.state);
  const logs = await readKnowledgeOperationalLogs({ organizationId: admin.state.organizationId ?? null });

  return NextResponse.json({
    success: true,
    data: {
      settings,
      resourceStatus,
      logs,
      storage: {
        scope: storage.scope,
      },
      permission: {
        canUpdate: admin.permission.canEnableKnowledge === true,
      },
    },
  });
}

export async function PATCH(request: NextRequest) {
  const admin = await requireOrganizationPermission(request, 'canEnableKnowledge', {
    errorMessage: 'Only users with Knowledge administration permission can update Knowledge settings.',
  });
  if (!admin.ok) return admin.response;

  const limited = rateLimit(request, {
    limit: 20,
    windowMs: 60_000,
    keyPrefix: `knowledge-settings-patch:${admin.session.user.id}`,
  });
  if (!limited.ok) return limited.response;

  try {
    const payload = await request.json().catch(() => ({})) as PatchPayload;
    const patch = extractSettingsPatch(payload);
    if (Object.keys(patch).length === 0) {
      return NextResponse.json(
        { success: false, error: 'No recognized settings keys provided.' },
        { status: 400 },
      );
    }
    const result = await updateKnowledgeParsingSettings({
      state: admin.state,
      actorUserId: admin.session.user.id,
      updates: patch,
    });

    await recordAuditEvent({
      organizationId: admin.state.organizationId,
      userId: admin.session.user.id,
      source: 'knowledge',
      eventType: 'admin',
      entityType: 'knowledge_settings',
      entityId: admin.state.organizationId ?? 'system',
      action: 'knowledge_settings.update',
      status: 'success',
      summary: 'Knowledge and parsing settings updated.',
      metadata: {
        changedKeys: Object.keys(patch),
        resourceProfile: result.resourceStatus.resourceProfile,
        availability: result.resourceStatus.availability,
        blockers: result.resourceStatus.blockers,
      },
    });

    return NextResponse.json({
      success: true,
      data: {
        settings: result.settings,
        resourceStatus: result.resourceStatus,
        logs: result.logs,
        storage: {
          scope: result.storage.scope,
        },
        permission: {
          canUpdate: true,
        },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update Knowledge settings.';
    const isPolicyBlock = message.startsWith(POLICY_BLOCK_ERROR_PREFIX);
    await recordAuditEvent({
      organizationId: admin.state.organizationId,
      userId: admin.session.user.id,
      source: 'knowledge',
      eventType: 'admin',
      entityType: 'knowledge_settings',
      entityId: admin.state.organizationId ?? 'system',
      action: 'knowledge_settings.update',
      status: isPolicyBlock ? 'blocked' : 'error',
      summary: isPolicyBlock
        ? 'Knowledge and parsing settings update was blocked.'
        : 'Knowledge and parsing settings update failed.',
      metadata: {
        error: message,
        errorType: isPolicyBlock ? 'policy_block' : 'server_error',
      },
    });
    return NextResponse.json(
      { success: false, error: isPolicyBlock ? message : 'Failed to update Knowledge settings.' },
      { status: isPolicyBlock ? 400 : 500 },
    );
  }
}
