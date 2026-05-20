import 'server-only';

import { getManagedControlPlaneBaseUrl } from '@/app/lib/managed/control-plane-url';
import { IntegrationServiceError } from '@/app/lib/integrations/integration-service-error';

export interface ManagedMediaReference {
  imageBytes: string;
  mimeType: string;
  fileName?: string;
  role?: 'start_frame' | 'end_frame' | 'reference' | 'reference_image' | 'reference_video' | 'reference_audio' | 'input_video';
}

export interface ManagedMediaOutput {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
  metadata?: Record<string, unknown>;
}

export interface ManagedMediaGenerateRequest {
  capability: 'image' | 'video' | 'sound';
  provider: 'gemini' | 'openai' | 'kie';
  model?: string | null;
  prompt?: string | null;
  parameters?: Record<string, unknown>;
  references?: ManagedMediaReference[];
  clientGenerationId?: string | null;
}

type CreateResponse = {
  jobId: string;
  status: string;
};

type JobResponse = {
  job?: {
    id: string;
    status: string;
    errorMessage?: string | null;
    outputs?: Array<{
      id: string;
      fileName: string;
      mimeType: string;
      downloadUrl: string;
      metadata?: Record<string, unknown>;
    }>;
  };
};

const POLL_INTERVAL_MS = 5_000;
const TIMEOUT_MS = 20 * 60_000;

function logInfo(message: string, data: Record<string, unknown> = {}) {
  console.log(`[Managed Media] ${message}`, JSON.stringify(data));
}

function logWarn(message: string, data: Record<string, unknown> = {}) {
  console.warn(`[Managed Media] ${message}`, JSON.stringify(data));
}

function logError(message: string, data: Record<string, unknown> = {}) {
  console.error(`[Managed Media] ${message}`, JSON.stringify(data));
}

export function isManagedMediaFallbackAvailable(): boolean {
  return (
    process.env.CANVAS_MANAGED_SERVICES_ENABLED === 'true' &&
    Boolean(getManagedControlPlaneBaseUrl()) &&
    Boolean(process.env.CANVAS_INSTANCE_TOKEN?.trim())
  );
}

function instanceToken(): string {
  const token = process.env.CANVAS_INSTANCE_TOKEN?.trim();
  if (!token) {
    throw new IntegrationServiceError(
      'Der lokale API-Key fehlt und der Managed Fallback über Canvas Control Plane ist nicht verfügbar. Bitte konfiguriere einen eigenen Key unter /settings?tab=integrations oder kontaktiere den Administrator.',
      400,
    );
  }
  return token;
}

function controlPlaneUrl(path: string): string {
  const baseUrl = getManagedControlPlaneBaseUrl();
  if (!baseUrl) {
    throw new IntegrationServiceError(
      'Der lokale API-Key fehlt und der Managed Fallback über Canvas Control Plane ist nicht verfügbar. Bitte konfiguriere einen eigenen Key unter /settings?tab=integrations oder kontaktiere den Administrator.',
      400,
    );
  }
  return `${baseUrl}${path}`;
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
      ? data.error
      : `Managed media request failed (${response.status})`;
    throw new IntegrationServiceError(message, response.status);
  }
  return data as T;
}

async function managedRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(controlPlaneUrl(path), {
    ...options,
    headers: {
      'Authorization': `Bearer ${instanceToken()}`,
      'Content-Type': 'application/json',
      ...(options?.headers || {}),
    },
  });
  return readJson<T>(response);
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function generateManagedMedia(request: ManagedMediaGenerateRequest): Promise<{
  jobId: string;
  outputs: ManagedMediaOutput[];
}> {
  if (!isManagedMediaFallbackAvailable()) {
    logWarn('fallback unavailable', {
      capability: request.capability,
      provider: request.provider,
      model: request.model,
      hasControlPlaneUrl: Boolean(getManagedControlPlaneBaseUrl()),
      hasInstanceToken: Boolean(process.env.CANVAS_INSTANCE_TOKEN?.trim()),
      managedEnabled: process.env.CANVAS_MANAGED_SERVICES_ENABLED === 'true',
    });
    throw new IntegrationServiceError(
      'Der lokale API-Key fehlt und der Managed Fallback über Canvas Control Plane ist nicht verfügbar. Bitte konfiguriere einen eigenen Key unter /settings?tab=integrations oder kontaktiere den Administrator.',
      400,
    );
  }

  logInfo('creating control-plane job', {
    capability: request.capability,
    provider: request.provider,
    model: request.model,
    referenceCount: request.references?.length || 0,
    referenceBytes: (request.references || []).reduce((sum, item) => sum + Buffer.byteLength(item.imageBytes || '', 'base64'), 0),
    clientGenerationId: request.clientGenerationId,
  });

  const created = await managedRequest<CreateResponse>('/v1/managed/media-generations', {
    method: 'POST',
    body: JSON.stringify(request),
  });
  logInfo('control-plane job created', {
    jobId: created.jobId,
    status: created.status,
    capability: request.capability,
    provider: request.provider,
    model: request.model,
  });

  const timeoutAt = Date.now() + TIMEOUT_MS;
  let job: NonNullable<JobResponse['job']> | null = null;
  let lastStatus: string | null = null;

  while (Date.now() < timeoutAt) {
    const response = await managedRequest<JobResponse>(`/v1/managed/media-generations/${created.jobId}`);
    job = response.job || null;
    if (job?.status !== lastStatus) {
      logInfo('control-plane job status', {
        jobId: created.jobId,
        status: job?.status || 'missing',
        outputCount: job?.outputs?.length || 0,
        hasError: Boolean(job?.errorMessage),
      });
      lastStatus = job?.status || null;
    }
    if (job?.status === 'succeeded') break;
    if (job?.status === 'failed' || job?.status === 'expired') {
      logError('control-plane job failed', {
        jobId: created.jobId,
        status: job.status,
        error: job.errorMessage || null,
      });
      throw new IntegrationServiceError(job.errorMessage || 'Managed media generation failed.', 502);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (!job || job.status !== 'succeeded') {
    logError('control-plane job timed out', {
      jobId: created.jobId,
      lastStatus: job?.status || null,
    });
    throw new IntegrationServiceError('Managed media generation timed out.', 504);
  }

  const outputs: ManagedMediaOutput[] = [];
  for (const output of job.outputs || []) {
    logInfo('downloading control-plane output', {
      jobId: created.jobId,
      outputId: output.id,
      fileName: output.fileName,
      mimeType: output.mimeType,
    });
    const download = await fetch(controlPlaneUrl(output.downloadUrl), {
      headers: { Authorization: `Bearer ${instanceToken()}` },
    });
    if (!download.ok) {
      logError('control-plane output download failed', {
        jobId: created.jobId,
        outputId: output.id,
        status: download.status,
      });
      throw new IntegrationServiceError(`Managed media output download failed (${download.status}).`, download.status);
    }
    const bytes = Buffer.from(await download.arrayBuffer());
    logInfo('control-plane output downloaded', {
      jobId: created.jobId,
      outputId: output.id,
      bytes: bytes.length,
      contentType: download.headers.get('content-type') || output.mimeType,
    });
    outputs.push({
      bytes,
      mimeType: download.headers.get('content-type') || output.mimeType,
      fileName: output.fileName,
      metadata: output.metadata,
    });
  }

  await managedRequest(`/v1/managed/media-generations/${created.jobId}/ack`, {
    method: 'POST',
    body: JSON.stringify({}),
  }).then(() => {
    logInfo('control-plane job acknowledged', {
      jobId: created.jobId,
      outputCount: outputs.length,
    });
  }).catch((error) => {
    logWarn('control-plane job acknowledge failed', {
      jobId: created.jobId,
      error: error instanceof Error ? error.message : 'unknown',
    });
  });

  return { jobId: created.jobId, outputs };
}
