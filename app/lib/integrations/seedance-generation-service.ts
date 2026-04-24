import 'server-only';

import { getKieApiKeyFromIntegrations } from '@/app/lib/integrations/env-config';
import { IntegrationServiceError } from '@/app/lib/integrations/integration-service-error';
import {
  ensureStudioOutputsWorkspace,
  generateOutputFilename,
  writeOutputFile,
} from '@/app/lib/integrations/studio-workspace';
import { toMediaUrl } from '@/app/lib/utils/media-url';

export const SEEDANCE_PROVIDER_ID = 'bytedance';
export const SEEDANCE_MODEL_ID = 'bytedance/seedance-2';

const KIE_API_BASE_URL = 'https://api.kie.ai';
const KIE_UPLOAD_BASE_URL = 'https://kieai.redpandaai.co';
const CREATE_TASK_PATH = '/api/v1/jobs/createTask';
const RECORD_INFO_PATH = '/api/v1/jobs/recordInfo';
const BASE64_UPLOAD_PATH = '/api/file-base64-upload';
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 10_000;

export type SeedanceResolution = '480p' | '720p' | '1080p';
export type SeedanceAspectRatio = '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '21:9' | 'adaptive';

export interface SeedanceReferenceImage {
  imageBytes: string;
  mimeType: string;
  fileName?: string;
}

export interface GenerateSeedanceVideoRequest {
  prompt: string;
  aspectRatio?: SeedanceAspectRatio;
  resolution?: SeedanceResolution;
  durationSeconds?: number;
  firstFrame?: SeedanceReferenceImage | null;
  lastFrame?: SeedanceReferenceImage | null;
  referenceImages?: SeedanceReferenceImage[];
  generateAudio?: boolean;
  webSearch?: boolean;
  nsfwChecker?: boolean;
  caller?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface SeedanceVideoGenerationResult {
  path: string;
  mediaUrl: string;
  fileSize: number;
  mimeType: string;
  metadata: Record<string, unknown>;
}

interface KieCreateTaskResponse {
  code?: number;
  msg?: string;
  message?: string;
  data?: {
    taskId?: string;
  };
}

interface KieRecordInfoResponse {
  code?: number;
  msg?: string;
  message?: string;
  data?: {
    taskId?: string;
    model?: string;
    state?: 'waiting' | 'queuing' | 'generating' | 'success' | 'fail' | string;
    resultJson?: string;
    failCode?: string;
    failMsg?: string;
    costTime?: number;
    completeTime?: number;
    createTime?: number;
    updateTime?: number;
  };
}

interface KieUploadResponse {
  success?: boolean;
  code?: number;
  msg?: string;
  message?: string;
  data?: {
    downloadUrl?: string;
    fileUrl?: string;
    fileName?: string;
    filePath?: string;
    fileSize?: number;
    mimeType?: string;
  };
}

function sanitizePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim().slice(0, 20_000);
}

function promptToSlug(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return slug || 'seedance-video';
}

function clampDuration(durationSeconds?: number): number {
  const normalized = Math.round(durationSeconds || 5);
  return Math.min(Math.max(normalized, 4), 15);
}

function extensionFromMime(mimeType: string): string {
  if (mimeType.includes('quicktime')) return 'mov';
  if (mimeType.includes('webm')) return 'webm';
  return 'mp4';
}

function extensionForImage(mimeType: string): string {
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('bmp')) return 'bmp';
  if (mimeType.includes('tiff')) return 'tiff';
  if (mimeType.includes('gif')) return 'gif';
  return 'png';
}

function getResponseMessage(body: { msg?: string; message?: string } | null | undefined, fallback: string): string {
  return body?.msg || body?.message || fallback;
}

function parseResultUrls(resultJson: string | undefined): string[] {
  if (!resultJson) return [];
  try {
    const parsed = JSON.parse(resultJson) as {
      resultUrls?: unknown;
      urls?: unknown;
      videoUrls?: unknown;
      videos?: unknown;
    };
    const candidates = parsed.resultUrls ?? parsed.videoUrls ?? parsed.urls ?? parsed.videos;
    if (!Array.isArray(candidates)) return [];
    return candidates.filter((value): value is string => typeof value === 'string' && value.length > 0);
  } catch {
    return [];
  }
}

async function kieFetch<T>(url: string, apiKey: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(init?.headers || {}),
    },
  });

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    throw new IntegrationServiceError(
      `KIE request failed: ${response.status} ${response.statusText}`,
      response.status,
    );
  }

  return body as T;
}

async function uploadReferenceImage(
  apiKey: string,
  image: SeedanceReferenceImage,
  index: number,
): Promise<string> {
  const extension = extensionForImage(image.mimeType);
  const fileName = image.fileName || `studio-reference-${Date.now()}-${index}.${extension}`;
  const body = await kieFetch<KieUploadResponse>(
    `${KIE_UPLOAD_BASE_URL}${BASE64_UPLOAD_PATH}`,
    apiKey,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base64Data: `data:${image.mimeType};base64,${image.imageBytes}`,
        uploadPath: 'canvas-studio/seedance',
        fileName,
      }),
    },
  );

  const downloadUrl = body.data?.downloadUrl || body.data?.fileUrl;
  if (!body.success || !downloadUrl) {
    throw new IntegrationServiceError(
      `KIE upload failed: ${getResponseMessage(body, 'missing download URL')}`,
      500,
    );
  }

  return downloadUrl;
}

async function createSeedanceTask(
  apiKey: string,
  request: GenerateSeedanceVideoRequest,
  uploaded: {
    firstFrameUrl?: string;
    lastFrameUrl?: string;
    referenceImageUrls: string[];
  },
): Promise<string> {
  const input: Record<string, unknown> = {
    prompt: sanitizePrompt(request.prompt),
    generate_audio: request.generateAudio ?? true,
    resolution: request.resolution || '720p',
    aspect_ratio: request.aspectRatio || '16:9',
    duration: clampDuration(request.durationSeconds),
    nsfw_checker: request.nsfwChecker ?? false,
  };

  if (request.webSearch !== undefined) {
    input.web_search = request.webSearch;
  }
  if (uploaded.firstFrameUrl) {
    input.first_frame_url = uploaded.firstFrameUrl;
  }
  if (uploaded.lastFrameUrl) {
    input.last_frame_url = uploaded.lastFrameUrl;
  }
  if (uploaded.referenceImageUrls.length > 0) {
    input.reference_image_urls = uploaded.referenceImageUrls;
  }

  const body = await kieFetch<KieCreateTaskResponse>(
    `${KIE_API_BASE_URL}${CREATE_TASK_PATH}`,
    apiKey,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: SEEDANCE_MODEL_ID,
        input,
      }),
    },
  );

  if (body.code !== 200 || !body.data?.taskId) {
    throw new IntegrationServiceError(
      `Seedance task creation failed: ${getResponseMessage(body, 'missing task ID')}`,
      500,
    );
  }

  return body.data.taskId;
}

async function pollSeedanceTask(
  apiKey: string,
  taskId: string,
  options: { pollIntervalMs?: number; timeoutMs?: number },
): Promise<NonNullable<KieRecordInfoResponse['data']>> {
  const timeoutAt = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  while (Date.now() <= timeoutAt) {
    const url = new URL(`${KIE_API_BASE_URL}${RECORD_INFO_PATH}`);
    url.searchParams.set('taskId', taskId);
    const body = await kieFetch<KieRecordInfoResponse>(url.toString(), apiKey);

    if (body.code !== 200 || !body.data) {
      throw new IntegrationServiceError(
        `Seedance task query failed: ${getResponseMessage(body, 'missing task data')}`,
        500,
      );
    }

    if (body.data.state === 'success') {
      return body.data;
    }

    if (body.data.state === 'fail') {
      throw new IntegrationServiceError(
        `Seedance generation failed: ${body.data.failMsg || body.data.failCode || 'unknown error'}`,
        500,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new IntegrationServiceError('Seedance generation timed out.', 504);
}

async function downloadVideo(url: string): Promise<{ bytes: Buffer; mimeType: string }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new IntegrationServiceError(
      `Failed to download Seedance video: ${response.status} ${response.statusText}`,
      response.status,
    );
  }
  const arrayBuffer = await response.arrayBuffer();
  return {
    bytes: Buffer.from(arrayBuffer),
    mimeType: response.headers.get('content-type') || 'video/mp4',
  };
}

export async function generateSeedanceVideo(
  request: GenerateSeedanceVideoRequest,
): Promise<SeedanceVideoGenerationResult> {
  const apiKey = await getKieApiKeyFromIntegrations();
  if (!apiKey) {
    throw new IntegrationServiceError(
      'KIE API key is missing. Configure KIE_API_KEY in /settings?tab=integrations.',
      400,
    );
  }

  const prompt = sanitizePrompt(request.prompt);
  if (prompt.length < 3) {
    throw new IntegrationServiceError('Prompt must be at least 3 characters for Seedance.', 400);
  }

  const hasFrameScenario = Boolean(request.firstFrame || request.lastFrame);
  const referenceImages = (request.referenceImages || []).slice(0, 9);
  if (hasFrameScenario && referenceImages.length > 0) {
    throw new IntegrationServiceError(
      'Seedance first/last-frame mode cannot be combined with reference images.',
      400,
    );
  }

  const uploadJobs: Array<Promise<{ kind: 'first' | 'last' | 'reference'; url: string }>> = [];
  if (request.firstFrame) {
    uploadJobs.push(uploadReferenceImage(apiKey, request.firstFrame, 0).then((url) => ({ kind: 'first' as const, url })));
  }
  if (request.lastFrame) {
    uploadJobs.push(uploadReferenceImage(apiKey, request.lastFrame, 1).then((url) => ({ kind: 'last' as const, url })));
  }
  referenceImages.forEach((image, index) => {
    uploadJobs.push(uploadReferenceImage(apiKey, image, index).then((url) => ({ kind: 'reference' as const, url })));
  });

  const uploadedResults = await Promise.all(uploadJobs);
  const uploaded = {
    firstFrameUrl: uploadedResults.find((item) => item.kind === 'first')?.url,
    lastFrameUrl: uploadedResults.find((item) => item.kind === 'last')?.url,
    referenceImageUrls: uploadedResults.filter((item) => item.kind === 'reference').map((item) => item.url),
  };

  const taskId = await createSeedanceTask(apiKey, request, uploaded);
  const task = await pollSeedanceTask(apiKey, taskId, {
    pollIntervalMs: request.pollIntervalMs,
    timeoutMs: request.timeoutMs,
  });
  const resultUrls = parseResultUrls(task.resultJson);
  const resultUrl = resultUrls[0];
  if (!resultUrl) {
    throw new IntegrationServiceError('Seedance generation completed without a video URL.', 500);
  }

  const downloaded = await downloadVideo(resultUrl);
  await ensureStudioOutputsWorkspace();

  const extension = extensionFromMime(downloaded.mimeType);
  const outputPath = generateOutputFilename(promptToSlug(prompt), 0, extension);
  await writeOutputFile(outputPath, downloaded.bytes);

  return {
    path: outputPath,
    mediaUrl: toMediaUrl(outputPath),
    fileSize: downloaded.bytes.length,
    mimeType: downloaded.mimeType,
    metadata: {
      provider: SEEDANCE_PROVIDER_ID,
      model: SEEDANCE_MODEL_ID,
      taskId,
      taskState: task.state,
      resultUrl,
      resultUrls,
      resolution: request.resolution || '720p',
      aspectRatio: request.aspectRatio || '16:9',
      durationSeconds: clampDuration(request.durationSeconds),
      generateAudio: request.generateAudio ?? true,
      webSearch: request.webSearch ?? null,
      nsfwChecker: request.nsfwChecker ?? false,
      caller: request.caller || 'studio-generation',
      uploaded,
      costTime: task.costTime ?? null,
      completeTime: task.completeTime ?? null,
      createTime: task.createTime ?? null,
      updateTime: task.updateTime ?? null,
    },
  };
}
