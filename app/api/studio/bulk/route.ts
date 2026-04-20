import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { createBulkJob, listBulkJobs } from '@/app/lib/integrations/studio-bulk-service';
import { StudioServiceError } from '@/app/lib/integrations/studio-errors';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  let body: {
    product_ids?: string[];
    prompt?: string;
    preset_id?: string;
    aspect_ratio?: string;
    versions_per_product?: number;
    line_item_overrides?: Array<{
      product_id: string;
      preset_id?: string;
      persona_id?: string;
      custom_prompt?: string;
    }>;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.product_ids || !Array.isArray(body.product_ids) || body.product_ids.length === 0) {
    return NextResponse.json({ success: false, error: 'product_ids is required and must be a non-empty array' }, { status: 400 });
  }

  if (!body.prompt || typeof body.prompt !== 'string' || body.prompt.trim().length === 0) {
    return NextResponse.json({ success: false, error: 'prompt is required' }, { status: 400 });
  }

  try {
    const job = await createBulkJob(session.user.id, {
      productIds: body.product_ids,
      prompt: body.prompt,
      presetId: body.preset_id,
      aspectRatio: body.aspect_ratio,
      versionsPerProduct: body.versions_per_product,
      lineItemOverrides: body.line_item_overrides?.map((o) => ({
        productId: o.product_id,
        presetId: o.preset_id,
        personaId: o.persona_id,
        customPrompt: o.custom_prompt,
      })),
    });

    return NextResponse.json({
      success: true,
      job: {
        id: job.id,
        status: job.status,
        totalLineItems: job.totalLineItems,
        completedLineItems: job.completedLineItems,
        failedLineItems: job.failedLineItems,
        lineItems: job.lineItems.map((li) => ({
          id: li.id,
          productId: li.productId,
          productName: li.productName,
          status: li.status,
          generationId: li.generationId,
        })),
      },
    }, { status: 201 });
  } catch (error) {
    if (error instanceof StudioServiceError && error.code === 'CONCURRENCY_LIMIT') {
      return NextResponse.json({ success: false, error: error.userMessage }, { status: 409 });
    }
    if (error instanceof StudioServiceError) {
      return NextResponse.json({ success: false, error: error.userMessage }, { status: 400 });
    }
    console.error('[Studio Bulk] POST error:', error);
    return NextResponse.json({ success: false, error: 'Bulk job creation failed' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const jobs = await listBulkJobs(session.user.id);
    return NextResponse.json({
      success: true,
      jobs: jobs.map((job) => ({
        id: job.id,
        name: job.name,
        status: job.status,
        totalLineItems: job.totalLineItems,
        completedLineItems: job.completedLineItems,
        failedLineItems: job.failedLineItems,
        aspectRatio: job.aspectRatio,
        versionsPerProduct: job.versionsPerProduct,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      })),
    });
  } catch (error) {
    console.error('[Studio Bulk] GET error:', error);
    return NextResponse.json({ success: false, error: 'Failed to list bulk jobs' }, { status: 500 });
  }
}