import { NextRequest, NextResponse } from 'next/server';

import type { SystemUpdateReleaseChannel } from '@/cli/src/core/systemUpdateContract';

import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { resolveSystemUpdateBackend } from '@/app/lib/system-updates/backend';
import { SystemUpdateBackendError } from '@/app/lib/system-updates/types';
import { rateLimit } from '@/app/lib/utils/rate-limit';

import { parseSystemUpdateChannel, systemUpdateErrorResponse } from './helpers';

export async function GET(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;
  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: `system-update-availability:${admin.session.user.id}`,
  });
  if (!limited.ok) return limited.response;

  try {
    const channel = parseSystemUpdateChannel(request.nextUrl.searchParams.get('channel'));
    const data = await resolveSystemUpdateBackend().getAvailability(channel);
    return NextResponse.json({ success: true, data }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return systemUpdateErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;
  const limited = rateLimit(request, {
    limit: 3,
    windowMs: 60_000,
    keyPrefix: `system-update-start:${admin.session.user.id}`,
  });
  if (!limited.ok) return limited.response;

  let channel: SystemUpdateReleaseChannel = 'stable';
  let expectedReleaseId: string | undefined;
  try {
    const payload = await request.json().catch(() => null);
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new SystemUpdateBackendError(400, 'request_invalid', 'Update request must be a JSON object.');
    }
    const input = payload as Record<string, unknown>;
    if (Object.keys(input).some((key) => key !== 'channel' && key !== 'expectedReleaseId')) {
      throw new SystemUpdateBackendError(400, 'request_invalid', 'Update request contains unsupported fields.');
    }
    channel = parseSystemUpdateChannel(input.channel);
    if (input.expectedReleaseId !== undefined) {
      if (typeof input.expectedReleaseId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(input.expectedReleaseId)) {
        throw new SystemUpdateBackendError(400, 'request_invalid', 'Expected release ID is invalid.');
      }
      expectedReleaseId = input.expectedReleaseId;
    }

    const backend = resolveSystemUpdateBackend();
    const operation = await backend.startUpdate({ channel, ...(expectedReleaseId ? { expectedReleaseId } : {}) });
    await recordAuditEvent({
      userId: admin.session.user.id,
      source: 'system_update',
      eventType: 'admin',
      entityType: 'system_update_operation',
      entityId: operation.operationId,
      action: 'system_update.start',
      status: 'started',
      summary: `Canvas Notebook update to ${operation.targetVersion} started.`,
      metadata: {
        mode: backend.mode,
        channel,
        currentVersion: operation.currentVersion,
        targetVersion: operation.targetVersion,
      },
    });
    return NextResponse.json({ success: true, operation }, {
      status: 202,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    await recordAuditEvent({
      userId: admin.session.user.id,
      source: 'system_update',
      eventType: 'admin',
      entityType: 'system_update_operation',
      action: 'system_update.start',
      status: 'failure',
      summary: 'Canvas Notebook update start was rejected or failed.',
      metadata: {
        channel,
        expectedReleaseId: expectedReleaseId || null,
        code: error instanceof SystemUpdateBackendError ? error.code : 'system_update_failed',
      },
    });
    return systemUpdateErrorResponse(error);
  }
}
