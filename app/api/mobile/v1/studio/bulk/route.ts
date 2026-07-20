import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { createBulkJob, listBulkJobs } from '@/app/lib/integrations/studio-bulk-service';
import { requireStudioRequestScope } from '@/app/lib/integrations/studio-request-scope';
import { MobileStudioError } from '@/app/lib/mobile/studio';
import { mobileStudioErrorResponse, mobileStudioResponseHeaders } from '@/app/lib/mobile/studio-route';

const BULK_ASPECT_RATIOS = new Set(['1:1', '4:5', '3:4', '4:3', '16:9', '9:16', '3:2', '2:3']);

function serializeJob(job: Awaited<ReturnType<typeof listBulkJobs>>[number]) {
  return {
    id: job.id, status: job.status, prompt: job.additionalPrompt || '', aspectRatio: job.aspectRatio,
    versionsPerProduct: job.versionsPerProduct, totalLineItems: job.totalLineItems,
    completedLineItems: job.completedLineItems, failedLineItems: job.failedLineItems,
    lineItems: job.lineItems.map((item) => ({
      id: item.id, productId: item.productId, productName: item.productName || '', status: item.status,
      generationId: item.generationId,
    })),
    createdAt: job.createdAt.toISOString(), updatedAt: job.updatedAt.toISOString(),
  };
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401, headers: mobileStudioResponseHeaders });
  const studioRequest = await requireStudioRequestScope(request, session);
  if (!studioRequest.scope) return studioRequest.response;
  try {
    return NextResponse.json({ success: true, jobs: (await listBulkJobs(studioRequest.scope)).slice(0, 50).map(serializeJob) }, { headers: mobileStudioResponseHeaders });
  } catch (error) { return mobileStudioErrorResponse(error, '[API] Mobile Studio bulk list failed:'); }
}

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401, headers: mobileStudioResponseHeaders });
  const studioRequest = await requireStudioRequestScope(request, session, { permissions: 'canWrite' });
  if (!studioRequest.scope) return studioRequest.response;
  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || !Array.isArray(body.productIds) || typeof body.prompt !== 'string') throw new MobileStudioError('Products and prompt are required.', 400, 'INVALID_BULK_REQUEST');
    const productIds = body.productIds.filter((id): id is string => typeof id === 'string').slice(0, 20);
    if (!productIds.length || productIds.length !== body.productIds.length) throw new MobileStudioError('Bulk products are invalid.', 400, 'INVALID_BULK_REQUEST');
    const aspectRatio = typeof body.aspectRatio === 'string' ? body.aspectRatio : '1:1';
    if (!BULK_ASPECT_RATIOS.has(aspectRatio)) throw new MobileStudioError('Bulk aspect ratio is invalid.', 400, 'INVALID_BULK_REQUEST');
    const job = await createBulkJob(studioRequest.scope, {
      productIds,
      prompt: body.prompt.trim().slice(0, 4_000),
      presetId: typeof body.presetId === 'string' ? body.presetId : undefined,
      aspectRatio,
      versionsPerProduct: Number.isSafeInteger(body.versionsPerProduct) ? Number(body.versionsPerProduct) : undefined,
    });
    return NextResponse.json({ success: true, job: serializeJob(job) }, { status: 201, headers: mobileStudioResponseHeaders });
  } catch (error) { return mobileStudioErrorResponse(error, '[API] Mobile Studio bulk create failed:'); }
}
