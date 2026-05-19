import 'server-only';

import { getManagedControlPlaneBaseUrl } from '@/app/lib/managed/control-plane-url';
import { IntegrationServiceError } from '@/app/lib/integrations/integration-service-error';

export interface ManagedMediaReference {
  imageBytes: string;
  mimeType: string;
  fileName?: string;
}

export interface ManagedMediaOutput {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
  metadata?: Record<string, unknown>;
}

export interface ManagedMediaGenerateRequest {
  capability: 'image' | 'video';
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
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = data && typeof data === 'object' && typeof data.error === 'string'
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
    throw new IntegrationServiceError(
      'Der lokale API-Key fehlt und der Managed Fallback über Canvas Control Plane ist nicht verfügbar. Bitte konfiguriere einen eigenen Key unter /settings?tab=integrations oder kontaktiere den Administrator.',
      400,
    );
  }

  const created = await managedRequest<CreateResponse>('/v1/managed/media-generations', {
    method: 'POST',
    body: JSON.stringify(request),
  });

  const timeoutAt = Date.now() + TIMEOUT_MS;
  let job: NonNullable<JobResponse['job']> | null = null;

  while (Date.now() < timeoutAt) {
    const response = await managedRequest<JobResponse>(`/v1/managed/media-generations/${created.jobId}`);
    job = response.job || null;
    if (job?.status === 'succeeded') break;
    if (job?.status === 'failed' || job?.status === 'expired') {
      throw new IntegrationServiceError(job.errorMessage || 'Managed media generation failed.', 502);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (!job || job.status !== 'succeeded') {
    throw new IntegrationServiceError('Managed media generation timed out.', 504);
  }

  const outputs: ManagedMediaOutput[] = [];
  for (const output of job.outputs || []) {
    const download = await fetch(controlPlaneUrl(output.downloadUrl), {
      headers: { Authorization: `Bearer ${instanceToken()}` },
    });
    if (!download.ok) {
      throw new IntegrationServiceError(`Managed media output download failed (${download.status}).`, download.status);
    }
    outputs.push({
      bytes: Buffer.from(await download.arrayBuffer()),
      mimeType: download.headers.get('content-type') || output.mimeType,
      fileName: output.fileName,
      metadata: output.metadata,
    });
  }

  await managedRequest(`/v1/managed/media-generations/${created.jobId}/ack`, {
    method: 'POST',
    body: JSON.stringify({}),
  }).catch(() => undefined);

  return { jobId: created.jobId, outputs };
}
