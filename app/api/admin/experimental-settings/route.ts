import { NextRequest, NextResponse } from 'next/server';

import { requireInstanceAdmin } from '@/app/lib/admin-auth';
import { readDocumentReviewAvailability } from '@/app/lib/document-review-availability';
import { readStudioBulkAvailability } from '@/app/lib/studio-bulk-availability';
import { readIntegrationToolGatewayAvailability } from '@/app/lib/integration-tool-gateway-availability';
import { setExperimentalFeatures, type ExperimentalFeaturesUpdate } from '@/app/lib/server-settings';

export async function GET(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;
  return NextResponse.json({ success: true, data: readIntegrationToolGatewayAvailability() }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function PATCH(request: NextRequest) {
  const admin = await requireInstanceAdmin(request);
  if (!admin.ok) return admin.response;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || !Object.keys(body).length
    || Object.keys(body).some(key => !['documentReviewEnabled', 'studioBulkEnabled', 'integrationToolGatewayEnabled'].includes(key)
      || typeof body[key] !== 'boolean')) {
    return NextResponse.json({ error: 'Provide supported experimental settings as booleans.' }, { status: 400 });
  }
  try {
    const settings = await setExperimentalFeatures(admin.session.user.id, body as ExperimentalFeaturesUpdate);
    const data = {
      documentReviewEnabled: settings.documentReviewEnabled === true,
      updatedAt: settings.documentReviewUpdatedAt ?? null,
      studioBulkEnabled: settings.studioBulkEnabled === true,
      studioBulkUpdatedAt: settings.studioBulkUpdatedAt ?? null,
      integrationToolGatewayEnabled: settings.integrationToolGatewayEnabled === true,
      integrationToolGatewayUpdatedAt: settings.integrationToolGatewayUpdatedAt ?? null,
    };
    return NextResponse.json({ success: true, data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[Experimental settings] Update failed:', error);
    const bulk = readStudioBulkAvailability();
    const gateway = readIntegrationToolGatewayAvailability();
    return NextResponse.json({ success: false, error: 'Failed to apply experimental settings.', data: {
      ...readDocumentReviewAvailability(), studioBulkEnabled: bulk.studioBulkEnabled, studioBulkUpdatedAt: bulk.updatedAt,
      integrationToolGatewayEnabled: gateway.integrationToolGatewayEnabled, integrationToolGatewayUpdatedAt: gateway.updatedAt,
    } }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
