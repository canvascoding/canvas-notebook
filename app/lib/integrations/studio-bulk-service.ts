import 'server-only';

import { randomUUID } from 'node:crypto';
import { db } from '@/app/lib/db';
import {
  studioBulkJobs,
  studioBulkJobLineItems,
  studioProducts,
  studioGenerationOutputs,
} from '@/app/lib/db/schema';
import { eq, and, desc, inArray, count } from 'drizzle-orm';
import { executeStudioGeneration, type StudioGenerateRequest } from '@/app/lib/integrations/studio-generation-service';
import { StudioServiceError } from '@/app/lib/integrations/studio-errors';

const MAX_PRODUCTS = 20;
const MIN_VERSIONS = 1;
const MAX_VERSIONS = 4;

type BulkJobStatus = 'pending' | 'processing' | 'completed' | 'partial' | 'failed';
type LineItemStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface CreateBulkJobInput {
  productIds: string[];
  prompt: string;
  presetId?: string;
  aspectRatio?: string;
  versionsPerProduct?: number;
  lineItemOverrides?: Array<{
    productId: string;
    presetId?: string;
    personaId?: string;
    customPrompt?: string;
  }>;
}

export interface BulkJobLineItem {
  id: string;
  bulkJobId: string;
  productId: string | null;
  productName: string | null;
  personaId: string | null;
  studioPresetId: string | null;
  customPrompt: string | null;
  generationId: string | null;
  status: LineItemStatus;
  outputs?: Array<{ id: string; mediaUrl: string | null; filePath: string }>;
  createdAt: Date;
}

export interface BulkJob {
  id: string;
  userId: string;
  name: string | null;
  studioPresetId: string | null;
  additionalPrompt: string | null;
  aspectRatio: string;
  versionsPerProduct: number;
  status: BulkJobStatus;
  totalLineItems: number;
  completedLineItems: number;
  failedLineItems: number;
  lineItems: BulkJobLineItem[];
  createdAt: Date;
  updatedAt: Date;
}

async function getProductName(productId: string): Promise<string | null> {
  const [product] = await db.select({ name: studioProducts.name })
    .from(studioProducts)
    .where(eq(studioProducts.id, productId));
  return product?.name ?? null;
}

async function checkConcurrency(userId: string): Promise<void> {
  const result = await db.select({ count: count() })
    .from(studioBulkJobs)
    .where(and(
      eq(studioBulkJobs.userId, userId),
      inArray(studioBulkJobs.status, ['pending', 'processing']),
    ));

  const activeCount = result[0]?.count ?? 0;
  if (activeCount > 0) {
    throw new StudioServiceError(
      'Concurrent bulk job limit reached',
      'Ein Bulk-Job ist bereits aktiv. Bitte brich ihn ab oder warte, bis er abgeschlossen ist.',
      'CONCURRENCY_LIMIT',
    );
  }
}

export async function createBulkJob(userId: string, data: CreateBulkJobInput): Promise<BulkJob> {
  if (data.productIds.length === 0) {
    throw new StudioServiceError(
      'No products provided',
      'Mindestens ein Produkt ist erforderlich.',
      'VALIDATION',
    );
  }

  if (data.productIds.length > MAX_PRODUCTS) {
    throw new StudioServiceError(
      `Too many products (${data.productIds.length})`,
      `Maximal ${MAX_PRODUCTS} Produkte pro Bulk-Job erlaubt.`,
      'VALIDATION',
    );
  }

  const versions = data.versionsPerProduct ?? 1;
  if (versions < MIN_VERSIONS || versions > MAX_VERSIONS) {
    throw new StudioServiceError(
      `Invalid versions_per_product: ${versions}`,
      `Versionen pro Produkt: ${MIN_VERSIONS}–${MAX_VERSIONS}.`,
      'VALIDATION',
    );
  }

  if (!data.prompt.trim()) {
    throw new StudioServiceError(
      'Empty prompt',
      'Ein Prompt ist erforderlich.',
      'VALIDATION',
    );
  }

  await checkConcurrency(userId);

  const jobId = randomUUID();
  const now = new Date();
  const totalLineItems = data.productIds.length * versions;

  const overridesMap = new Map(
    (data.lineItemOverrides ?? []).map((o) => [o.productId, o]),
  );

  const lineItemValues: Array<{
    id: string;
    bulkJobId: string;
    productId: string | null;
    personaId: string | null;
    studioPresetId: string | null;
    customPrompt: string | null;
    generationId: string | null;
    status: string;
    createdAt: Date;
  }> = [];

  for (const productId of data.productIds) {
    const override = overridesMap.get(productId);
    for (let v = 0; v < versions; v++) {
      lineItemValues.push({
        id: randomUUID(),
        bulkJobId: jobId,
        productId,
        personaId: override?.personaId ?? null,
        studioPresetId: override?.presetId ?? null,
        customPrompt: override?.customPrompt ?? null,
        generationId: null,
        status: 'pending',
        createdAt: now,
      });
    }
  }

  await db.insert(studioBulkJobs).values({
    id: jobId,
    userId,
    name: null,
    studioPresetId: data.presetId ?? null,
    additionalPrompt: data.prompt.trim(),
    aspectRatio: data.aspectRatio ?? '1:1',
    versionsPerProduct: versions,
    status: 'pending',
    totalLineItems,
    completedLineItems: 0,
    failedLineItems: 0,
    createdAt: now,
    updatedAt: now,
  });

  for (const item of lineItemValues) {
    await db.insert(studioBulkJobLineItems).values(item);
  }

  processBulkJob(jobId, userId, data.prompt.trim(), data.presetId, data.aspectRatio ?? '1:1').catch((err) => {
    console.error(`[BulkJob ${jobId}] Unhandled processing error:`, err);
  });

  return getBulkJobOrThrow(jobId);
}

async function processBulkJob(
  jobId: string,
  userId: string,
  batchPrompt: string,
  batchPresetId: string | undefined,
  batchAspectRatio: string,
): Promise<void> {
  await db.update(studioBulkJobs)
    .set({ status: 'processing', updatedAt: new Date() })
    .where(eq(studioBulkJobs.id, jobId));

  const items = await db.select()
    .from(studioBulkJobLineItems)
    .where(eq(studioBulkJobLineItems.bulkJobId, jobId))
    .orderBy(studioBulkJobLineItems.createdAt);

  let completedCount = 0;
  let failedCount = 0;

  for (const item of items) {
    const currentJob = await db.select({ status: studioBulkJobs.status })
      .from(studioBulkJobs)
      .where(eq(studioBulkJobs.id, jobId));

    if (!currentJob[0] || currentJob[0].status === 'failed') {
      break;
    }

    await db.update(studioBulkJobLineItems)
      .set({ status: 'processing' })
      .where(eq(studioBulkJobLineItems.id, item.id));

    try {
      const prompt = item.customPrompt ?? batchPrompt;
      const presetId = item.studioPresetId ?? batchPresetId ?? undefined;
      const personaIds = item.personaId ? [item.personaId] : undefined;
      const productIds = item.productId ? [item.productId] : undefined;

      const request: StudioGenerateRequest = {
        prompt,
        mode: 'image',
        product_ids: productIds,
        persona_ids: personaIds,
        preset_id: presetId,
        aspect_ratio: batchAspectRatio,
        count: 1,
        provider: 'gemini',
      };

      const result = await executeStudioGeneration(userId, request);

      await db.update(studioBulkJobLineItems)
        .set({ status: 'completed', generationId: result.generationId })
        .where(eq(studioBulkJobLineItems.id, item.id));

      completedCount++;
    } catch (err) {
      console.error(`[BulkJob ${jobId}] Line item ${item.id} failed:`, err);
      await db.update(studioBulkJobLineItems)
        .set({ status: 'failed' })
        .where(eq(studioBulkJobLineItems.id, item.id));
      failedCount++;
    }

    await db.update(studioBulkJobs)
      .set({
        completedLineItems: completedCount,
        failedLineItems: failedCount,
        updatedAt: new Date(),
      })
      .where(eq(studioBulkJobs.id, jobId));
  }

  let finalStatus: BulkJobStatus;
  if (completedCount === items.length) {
    finalStatus = 'completed';
  } else if (failedCount === items.length) {
    finalStatus = 'failed';
  } else {
    finalStatus = 'partial';
  }

  await db.update(studioBulkJobs)
    .set({ status: finalStatus, updatedAt: new Date() })
    .where(eq(studioBulkJobs.id, jobId));
}

async function getBulkJobOrThrow(jobId: string): Promise<BulkJob> {
  const job = await getBulkJob(jobId);
  if (!job) {
    throw new StudioServiceError(
      `Bulk job ${jobId} not found`,
      'Bulk-Job nicht gefunden.',
      'NOT_FOUND',
    );
  }
  return job;
}

export async function getBulkJob(jobId: string): Promise<BulkJob | null> {
  const [job] = await db.select()
    .from(studioBulkJobs)
    .where(eq(studioBulkJobs.id, jobId));

  if (!job) return null;

  const items = await db.select()
    .from(studioBulkJobLineItems)
    .where(eq(studioBulkJobLineItems.bulkJobId, jobId))
    .orderBy(studioBulkJobLineItems.createdAt);

  const lineItems: BulkJobLineItem[] = await Promise.all(
    items.map(async (item) => {
      let outputs: Array<{ id: string; mediaUrl: string | null; filePath: string }> | undefined;
      let productName: string | null = null;

      if (item.productId) {
        productName = await getProductName(item.productId);
      }

      if (item.generationId) {
        const outputRows = await db.select({
          id: studioGenerationOutputs.id,
          mediaUrl: studioGenerationOutputs.mediaUrl,
          filePath: studioGenerationOutputs.filePath,
        })
          .from(studioGenerationOutputs)
          .where(eq(studioGenerationOutputs.generationId, item.generationId));

        outputs = outputRows.map((o) => ({
          id: o.id,
          mediaUrl: o.mediaUrl,
          filePath: o.filePath,
        }));
      }

      return {
        id: item.id,
        bulkJobId: item.bulkJobId,
        productId: item.productId,
        productName,
        personaId: item.personaId,
        studioPresetId: item.studioPresetId,
        customPrompt: item.customPrompt,
        generationId: item.generationId,
        status: item.status as LineItemStatus,
        outputs,
        createdAt: item.createdAt,
      };
    }),
  );

  return {
    id: job.id,
    userId: job.userId,
    name: job.name,
    studioPresetId: job.studioPresetId,
    additionalPrompt: job.additionalPrompt,
    aspectRatio: job.aspectRatio,
    versionsPerProduct: job.versionsPerProduct,
    status: job.status as BulkJobStatus,
    totalLineItems: job.totalLineItems,
    completedLineItems: job.completedLineItems,
    failedLineItems: job.failedLineItems,
    lineItems,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export async function listBulkJobs(userId: string): Promise<BulkJob[]> {
  const jobs = await db.select()
    .from(studioBulkJobs)
    .where(eq(studioBulkJobs.userId, userId))
    .orderBy(desc(studioBulkJobs.createdAt));

  const result: BulkJob[] = [];
  for (const job of jobs) {
    const items = await db.select()
      .from(studioBulkJobLineItems)
      .where(eq(studioBulkJobLineItems.bulkJobId, job.id))
      .orderBy(studioBulkJobLineItems.createdAt);

    const lineItems: BulkJobLineItem[] = await Promise.all(
      items.map(async (item) => {
        let productName: string | null = null;
        if (item.productId) {
          productName = await getProductName(item.productId);
        }
        return {
          id: item.id,
          bulkJobId: item.bulkJobId,
          productId: item.productId,
          productName,
          personaId: item.personaId,
          studioPresetId: item.studioPresetId,
          customPrompt: item.customPrompt,
          generationId: item.generationId,
          status: item.status as LineItemStatus,
          createdAt: item.createdAt,
        };
      }),
    );

    result.push({
      id: job.id,
      userId: job.userId,
      name: job.name,
      studioPresetId: job.studioPresetId,
      additionalPrompt: job.additionalPrompt,
      aspectRatio: job.aspectRatio,
      versionsPerProduct: job.versionsPerProduct,
      status: job.status as BulkJobStatus,
      totalLineItems: job.totalLineItems,
      completedLineItems: job.completedLineItems,
      failedLineItems: job.failedLineItems,
      lineItems,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  }

  return result;
}

export async function cancelBulkJob(jobId: string): Promise<void> {
  const [job] = await db.select()
    .from(studioBulkJobs)
    .where(eq(studioBulkJobs.id, jobId));

  if (!job) {
    throw new StudioServiceError(
      `Bulk job ${jobId} not found`,
      'Bulk-Job nicht gefunden.',
      'NOT_FOUND',
    );
  }

  if (job.status !== 'pending' && job.status !== 'processing') {
    throw new StudioServiceError(
      `Cannot cancel job in status '${job.status}'`,
      'Nur aktive oder ausstehende Jobs können abgebrochen werden.',
      'INVALID_STATUS',
    );
  }

  await db.update(studioBulkJobLineItems)
    .set({ status: 'failed' })
    .where(and(
      eq(studioBulkJobLineItems.bulkJobId, jobId),
      inArray(studioBulkJobLineItems.status, ['pending', 'processing']),
    ));

  const items = await db.select()
    .from(studioBulkJobLineItems)
    .where(eq(studioBulkJobLineItems.bulkJobId, jobId));

  const completedCount = items.filter((i) => i.status === 'completed').length;
  const failedCount = items.filter((i) => i.status === 'failed').length;

  await db.update(studioBulkJobs)
    .set({
      status: 'failed',
      completedLineItems: completedCount,
      failedLineItems: failedCount,
      updatedAt: new Date(),
    })
    .where(eq(studioBulkJobs.id, jobId));
}

export async function deleteBulkJob(jobId: string): Promise<void> {
  const [job] = await db.select()
    .from(studioBulkJobs)
    .where(eq(studioBulkJobs.id, jobId));

  if (!job) {
    throw new StudioServiceError(
      `Bulk job ${jobId} not found`,
      'Bulk-Job nicht gefunden.',
      'NOT_FOUND',
    );
  }

  if (job.status === 'pending' || job.status === 'processing') {
    throw new StudioServiceError(
      `Cannot delete active job '${jobId}'`,
      'Bitte brich den Job zuerst ab, bevor du ihn loeschst.',
      'INVALID_STATUS',
    );
  }

  await db.delete(studioBulkJobs).where(eq(studioBulkJobs.id, jobId));
}