import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { getBulkJob, deleteBulkJob } from '@/app/lib/integrations/studio-bulk-service';
import { StudioServiceError } from '@/app/lib/integrations/studio-errors';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: _request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  try {
    const job = await getBulkJob(id);
    if (!job || job.userId !== session.user.id) {
      return NextResponse.json({ success: false, error: 'Bulk job not found' }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      job: {
        id: job.id,
        name: job.name,
        studioPresetId: job.studioPresetId,
        additionalPrompt: job.additionalPrompt,
        aspectRatio: job.aspectRatio,
        versionsPerProduct: job.versionsPerProduct,
        status: job.status,
        totalLineItems: job.totalLineItems,
        completedLineItems: job.completedLineItems,
        failedLineItems: job.failedLineItems,
        lineItems: job.lineItems.map((li) => ({
          id: li.id,
          productId: li.productId,
          productName: li.productName,
          personaId: li.personaId,
          studioPresetId: li.studioPresetId,
          customPrompt: li.customPrompt,
          generationId: li.generationId,
          status: li.status,
          outputs: li.outputs?.map((o) => ({
            id: o.id,
            mediaUrl: o.mediaUrl,
            filePath: o.filePath,
          })),
          createdAt: li.createdAt,
        })),
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      },
    });
  } catch (error) {
    if (error instanceof StudioServiceError) {
      return NextResponse.json({ success: false, error: error.userMessage }, { status: 400 });
    }
    console.error('[Studio Bulk] GET [id] error:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch bulk job' }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: _request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  try {
    const job = await getBulkJob(id);
    if (!job || job.userId !== session.user.id) {
      return NextResponse.json({ success: false, error: 'Bulk job not found' }, { status: 404 });
    }

    await deleteBulkJob(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof StudioServiceError) {
      const status = error.code === 'INVALID_STATUS' ? 409 : 400;
      return NextResponse.json({ success: false, error: error.userMessage }, { status });
    }
    console.error('[Studio Bulk] DELETE [id] error:', error);
    return NextResponse.json({ success: false, error: 'Failed to delete bulk job' }, { status: 500 });
  }
}