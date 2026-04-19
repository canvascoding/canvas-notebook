import { type AgentTool } from '@mariozechner/pi-agent-core';
import { type ImageContent } from '@mariozechner/pi-ai';
import { Type } from '@sinclair/typebox';
import { exec, execFile } from 'child_process';
import { promises as fsPromises } from 'fs';
import { promisify } from 'util';
import { getWorkspacePath } from '../utils/workspace-manager';
import path from 'path';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

// NOTE: resolveAgentPath intentionally has NO sandbox restriction.
// The agent must be able to access /data/canvas-agent (its own config/memory files)
// in addition to /data/workspace. Relative paths still resolve from the workspace
// root for convenience. The UI file browser (api/files/*) remains sandboxed via
// workspace-files.ts — only agent tools use this unrestricted resolver.
const AGENT_DATA = process.env.DATA || path.join(process.cwd(), 'data');
const AGENT_WORKSPACE_ROOT = path.join(AGENT_DATA, 'workspace');

function resolveAgentPath(p: string): string {
  return path.isAbsolute(p) ? p : path.join(AGENT_WORKSPACE_ROOT, p);
}
import {
  IMAGE_GENERATION_ALL_FAILED_MESSAGE,
  generateImages,
  type ImageGenerationResultData,
} from '../integrations/image-generation-service';
import {
  generateVideo,
  type GenerateVideoRequestBody,
  type GenerationMode,
} from '../integrations/veo-generation-service';
import {
  AD_LOCALIZATION_ALL_FAILED_MESSAGE,
  localizeAd,
  type AdLocalizationResultData,
} from '../integrations/ad-localization-service';
import { readPiRuntimeConfig } from '../agents/storage';
import { resolveEnabledToolNames, isLegacyEnabledToolsValue } from './enabled-tools';
import {
  QMD_CANONICAL_TOOL_NAME,
  extractFirstJsonArray,
  formatQmdSearchSummary,
  isQmdEnabled,
  mergeQmdResults,
  normalizeQmdCollections,
  normalizeQmdMode,
  normalizeQmdResults,
  type QmdSearchMode,
} from '../qmd/runtime';
import {
  createAutomationJob,
  deleteAutomationJob,
  getAutomationJob,
  listAutomationJobs,
  scheduleAutomationJobRun,
  updateAutomationJob,
} from '../automations/store';
import {
  type AutomationIntervalUnit,
  type AutomationJobRecord,
  type AutomationJobStatus,
  type AutomationPreferredSkill,
  type AutomationWeekday,
  type FriendlySchedule,
} from '../automations/types';


const execAsync = promisify(exec);


const IMAGE_EXTENSIONS: Record<string, string> = {
  '.gif':  'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg':  'image/jpeg',
  '.png':  'image/png',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
};

type VideoAspectRatio = NonNullable<GenerateVideoRequestBody['aspectRatio']>;
type VideoResolution = NonNullable<GenerateVideoRequestBody['resolution']>;
type GenerateImagesFn = typeof generateImages;
type GenerateVideoFn = typeof generateVideo;

type ImageGenerationToolParams = {
  prompt?: string;
  count: number;
  aspect_ratio?: string;
  model?: string;
  reference_image_paths?: string[];
  provider?: string;
  quality?: string;
  output_format?: string;
  background?: string;
};

type VideoGenerationToolParams = {
  prompt?: string;
  mode?: GenerationMode;
  aspect_ratio?: VideoAspectRatio;
  resolution?: VideoResolution;
  model?: string;
  start_frame_path?: string;
  end_frame_path?: string;
  reference_image_paths?: string[];
  input_video_path?: string;
  is_looping?: boolean;
};

const VIDEO_GENERATION_MODES: readonly GenerationMode[] = [
  'text_to_video',
  'frames_to_video',
  'references_to_video',
  'extend_video',
];

const VIDEO_ASPECT_RATIOS: readonly VideoAspectRatio[] = ['16:9', '9:16'];
const VIDEO_RESOLUTIONS: readonly VideoResolution[] = ['720p', '1080p', '4k'];

function isGenerationMode(value: string): value is GenerationMode {
  return VIDEO_GENERATION_MODES.includes(value as GenerationMode);
}

function isVideoAspectRatio(value: string): value is VideoAspectRatio {
  return VIDEO_ASPECT_RATIOS.includes(value as VideoAspectRatio);
}

function isVideoResolution(value: string): value is VideoResolution {
  return VIDEO_RESOLUTIONS.includes(value as VideoResolution);
}

function imageContentForBuffer(filePath: string, buffer: Buffer): ImageContent | null {
  const mimeType = IMAGE_EXTENSIONS[path.extname(filePath).toLowerCase()];
  if (!mimeType) return null;
  return { type: 'image', data: buffer.toString('base64'), mimeType };
}

type CommandExecutionError = Error & {
  code?: number;
  stdout?: string;
  stderr?: string;
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown tool error';
}

function asCommandExecutionError(error: unknown): CommandExecutionError {
  return error instanceof Error ? (error as CommandExecutionError) : new Error(String(error));
}

function clampMaxResults(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.min(Math.trunc(value), max));
}

function formatImageGenerationText(data: ImageGenerationResultData): string {
  let resultText = `Image generation complete: ${data.successCount} successful, ${data.failureCount} failed\n\n`;
  data.results.forEach((result) => {
    if (result.path) {
      resultText += `Image ${result.index + 1}: ${result.path}\n`;
      if (result.mediaUrl) {
        resultText += `URL: ${result.mediaUrl}\n`;
      }
    } else if (result.error) {
      resultText += `Image ${result.index + 1}: Failed - ${result.error}\n`;
    }
    resultText += '\n';
  });
  return resultText;
}

function formatAdLocalizationText(data: AdLocalizationResultData): string {
  let resultText = `Ad localization complete: ${data.successCount} successful, ${data.failureCount} failed\n\n`;
  data.results.forEach((result) => {
    if (result.path) {
      resultText += `Market: ${result.market}\n`;
      resultText += `Path: ${result.path}\n`;
      if (result.mediaUrl) {
        resultText += `URL: ${result.mediaUrl}\n`;
      }
    } else if (result.error) {
      resultText += `Market: ${result.market} - Failed: ${result.error}\n`;
    }
    resultText += '\n';
  });
  return resultText;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

const VALID_AUTOMATION_PREFERRED_SKILLS: AutomationPreferredSkill[] = [
  'auto',
  'image_generation',
  'video_generation',
  'ad_localization',
  'qmd',
  'qmd_search',
];
const VALID_AUTOMATION_DAYS: AutomationWeekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const VALID_AUTOMATION_INTERVAL_UNITS: AutomationIntervalUnit[] = ['minutes', 'hours', 'days'];

function formatAutomationJob(job: AutomationJobRecord): string {
  const schedule = JSON.stringify(job.schedule);
  const outputPath = job.targetOutputPath || job.effectiveTargetOutputPath;
  return [
    `ID: ${job.id}`,
    `Name: ${job.name}`,
    `Status: ${job.status}`,
    `Preferred skill: ${job.preferredSkill}`,
    `Schedule: ${schedule}`,
    `Next run: ${job.nextRunAt || 'not scheduled'}`,
    `Last run: ${job.lastRunAt || 'never'}`,
    `Last run status: ${job.lastRunStatus || 'n/a'}`,
    `Output: ${outputPath}`,
  ].join('\n');
}

function normalizeAutomationPreferredSkill(value: string | undefined): AutomationPreferredSkill | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim();
  if (normalized === 'qmd_search') {
    return 'qmd';
  }
  return VALID_AUTOMATION_PREFERRED_SKILLS.includes(normalized as AutomationPreferredSkill)
    ? (normalized as AutomationPreferredSkill)
    : undefined;
}

function normalizeAutomationStatus(value: string | undefined): AutomationJobStatus | undefined {
  if (!value) {
    return undefined;
  }
  return value === 'paused' ? 'paused' : value === 'active' ? 'active' : undefined;
}

function normalizeAutomationSchedule(schedule: {
  kind: string;
  date?: string;
  time?: string;
  days?: string[];
  every?: number;
  unit?: string;
  timeZone?: string;
}): FriendlySchedule {
  const timeZone = schedule.timeZone?.trim() || 'UTC';

  switch (schedule.kind) {
    case 'once':
      if (!schedule.date || !schedule.time) {
        throw new Error('once schedule requires date and time.');
      }
      return { kind: 'once', date: schedule.date, time: schedule.time, timeZone };
    case 'daily':
      if (!schedule.time) {
        throw new Error('daily schedule requires time.');
      }
      return { kind: 'daily', time: schedule.time, timeZone };
    case 'weekly': {
      const days = (schedule.days || []).filter((day): day is AutomationWeekday =>
        VALID_AUTOMATION_DAYS.includes(day as AutomationWeekday),
      );
      if (days.length === 0 || !schedule.time) {
        throw new Error('weekly schedule requires at least one valid day and a time.');
      }
      return { kind: 'weekly', days, time: schedule.time, timeZone };
    }
    case 'interval':
      if (!schedule.every || !schedule.unit || !VALID_AUTOMATION_INTERVAL_UNITS.includes(schedule.unit as AutomationIntervalUnit)) {
        throw new Error('interval schedule requires every and a valid unit.');
      }
      return { kind: 'interval', every: schedule.every, unit: schedule.unit as AutomationIntervalUnit, timeZone };
    default:
      throw new Error(`Unsupported automation schedule kind: ${schedule.kind}`);
  }
}

function normalizeAutomationWorkspacePaths(paths: string[] | undefined): string[] | undefined {
  if (!paths) {
    return undefined;
  }

  const normalized = paths
    .map((entry) => entry.trim().replace(/^\/+|^\.\/+/, ''))
    .filter(Boolean)
    .slice(0, 20);

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeWorkspaceRelativePath(value: string | undefined, fieldName: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalizedPath = path.posix.normalize(trimmed).replace(/^\.?\//, '');
  if (
    !normalizedPath ||
    normalizedPath === '.' ||
    normalizedPath.startsWith('/') ||
    normalizedPath.startsWith('../') ||
    normalizedPath.includes('/../')
  ) {
    throw new Error(`${fieldName} must be a workspace-relative path.`);
  }

  return normalizedPath;
}

function normalizeWorkspaceRelativePathList(values: string[] | undefined, fieldName: string): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const normalizedPath = normalizeWorkspaceRelativePath(value, fieldName);
    if (!normalizedPath || seen.has(normalizedPath)) {
      continue;
    }

    seen.add(normalizedPath);
    normalized.push(normalizedPath);
  }

  return normalized;
}

export function createImageGenerationTool(
  deps: { generateImagesFn?: GenerateImagesFn } = {},
): AgentTool {
  const generateImagesFn = deps.generateImagesFn ?? generateImages;

  return {
    name: 'image_generation',
    label: 'Generating images',
    description:
      'Generates images using the local Canvas image-generation service. Use this direct PI tool for image creation, image variations from workspace-relative reference images, and style-guided image generation. Supports both Google Gemini and OpenAI GPT Image providers. Output: workspace/image-generation/generations/. After a successful result with mediaUrl, the assistant should also embed the generated image in the normal chat reply as Markdown `![generated image](URL)` and still include the URL or path in text.',
    parameters: Type.Object({
      prompt: Type.Optional(Type.String({ description: 'Text description of the image to generate. Optional when reference_image_paths is provided.' })),
      count: Type.Number({ description: 'Number of images to generate (1-10, max depends on provider)' }),
      aspect_ratio: Type.Optional(Type.String({ description: 'Aspect ratio: 16:9, 1:1, 9:16, 4:3, 3:4. OpenAI also supports auto. Default: 1:1' })),
      model: Type.Optional(Type.String({ description: 'Model ID. Gemini: gemini-3.1-flash-image-preview (best, 14 refs), gemini-2.5-flash-image (fast, 3 refs). OpenAI: gpt-image-1.5 (best), gpt-image-1, gpt-image-1-mini (fast).' })),
      reference_image_paths: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Workspace-relative reference image paths. Optional, but at least one prompt or reference_image_paths entry is required.',
        }),
      ),
      provider: Type.Optional(Type.String({ description: 'Provider: gemini or openai. Default: gemini' })),
      quality: Type.Optional(Type.String({ description: 'Image quality: auto, low, medium, high (OpenAI only)' })),
      output_format: Type.Optional(Type.String({ description: 'Output format: png, jpeg, webp (OpenAI only)' })),
      background: Type.Optional(Type.String({ description: 'Background: auto, opaque, transparent (OpenAI only)' })),
    }),
    execute: async (toolCallId, params) => {
      const { prompt, aspect_ratio, count, model, reference_image_paths, provider, quality, output_format, background } = params as ImageGenerationToolParams;
      try {
        const normalizedPrompt = normalizeOptionalString(prompt);
        const referenceImagePaths = normalizeWorkspaceRelativePathList(
          reference_image_paths,
          'reference_image_paths',
        );

        if (!normalizedPrompt && referenceImagePaths.length === 0) {
          throw new Error('Either prompt or reference_image_paths is required.');
        }

        const requestParams: Record<string, unknown> = {
          prompt: normalizedPrompt,
          aspectRatio: aspect_ratio || '1:1',
          imageCount: count,
          model: model || (provider === 'openai' ? 'gpt-image-1.5' : 'gemini-3.1-flash-image-preview'),
          referenceImagePaths,
          provider: provider || 'gemini',
        };

        if (quality) requestParams.quality = quality;
        if (output_format) requestParams.outputFormat = output_format;
        if (background) requestParams.background = background;

        const data = await generateImagesFn(
          requestParams as Parameters<typeof generateImages>[0],
          'pi-agent',
        );

        if (data.successCount === 0) {
          return {
            content: [{ type: 'text', text: `Error: ${IMAGE_GENERATION_ALL_FAILED_MESSAGE}` }],
            details: { error: IMAGE_GENERATION_ALL_FAILED_MESSAGE, data },
          };
        }

        return {
          content: [{ type: 'text', text: formatImageGenerationText(data) }],
          details: data,
        };
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  };
}

export function createVideoGenerationTool(
  deps: { generateVideoFn?: GenerateVideoFn } = {},
): AgentTool {
  const generateVideoFn = deps.generateVideoFn ?? generateVideo;

  return {
    name: 'video_generation',
    label: 'Generating videos',
    description:
      'Generates videos using the local Canvas video-generation service. Use this direct PI tool for text-to-video, frames-to-video with workspace-relative start/end frames, references-to-video with workspace-relative image references, and extend-video with a workspace-relative input video. Output: workspace/veo-studio/video-generation/. Note: Takes 3-10 minutes.',
    parameters: Type.Object({
      prompt: Type.Optional(Type.String({ description: 'Text description of the video to generate. Required for text_to_video and references_to_video.' })),
      mode: Type.Optional(
        Type.Union([
          Type.Literal('text_to_video'),
          Type.Literal('frames_to_video'),
          Type.Literal('references_to_video'),
          Type.Literal('extend_video'),
        ], { description: 'Mode: text_to_video (default), frames_to_video, references_to_video, extend_video' }),
      ),
      aspect_ratio: Type.Optional(
        Type.Union([
          Type.Literal('16:9'),
          Type.Literal('9:16'),
        ], { description: 'Aspect ratio: 16:9 or 9:16. Default: 16:9' }),
      ),
      resolution: Type.Optional(
        Type.Union([
          Type.Literal('720p'),
          Type.Literal('1080p'),
          Type.Literal('4k'),
        ], { description: 'Resolution: 720p (default), 1080p, 4k' }),
      ),
      model: Type.Optional(
        Type.String({
          description: 'Model: veo-3.1-fast-generate-preview (default) or veo-3.1-generate-preview.',
        }),
      ),
      start_frame_path: Type.Optional(
        Type.String({ description: 'Workspace-relative path to the start frame. Required for frames_to_video.' }),
      ),
      end_frame_path: Type.Optional(
        Type.String({ description: 'Workspace-relative path to the end frame. Optional for frames_to_video.' }),
      ),
      reference_image_paths: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Workspace-relative reference image paths for references_to_video mode.',
        }),
      ),
      input_video_path: Type.Optional(
        Type.String({ description: 'Workspace-relative path to the input video. Required for extend_video.' }),
      ),
      is_looping: Type.Optional(
        Type.Boolean({ description: 'When true in frames_to_video mode, reuse start_frame_path as the last frame.' }),
      ),
    }),
    execute: async (toolCallId, params) => {
      const {
        prompt,
        mode,
        aspect_ratio,
        resolution,
        model,
        start_frame_path,
        end_frame_path,
        reference_image_paths,
        input_video_path,
        is_looping,
      } = params as VideoGenerationToolParams;
      try {
        if (mode && !isGenerationMode(mode)) {
          throw new Error(`Invalid mode "${mode}". Allowed values: ${VIDEO_GENERATION_MODES.join(', ')}`);
        }
        if (aspect_ratio && !isVideoAspectRatio(aspect_ratio)) {
          throw new Error(`Invalid aspect ratio "${aspect_ratio}". Allowed values: ${VIDEO_ASPECT_RATIOS.join(', ')}`);
        }
        if (resolution && !isVideoResolution(resolution)) {
          throw new Error(`Invalid resolution "${resolution}". Allowed values: ${VIDEO_RESOLUTIONS.join(', ')}`);
        }

        const normalizedPrompt = normalizeOptionalString(prompt);
        const selectedMode = mode ?? 'text_to_video';
        const startFramePath = normalizeWorkspaceRelativePath(start_frame_path, 'start_frame_path');
        const endFramePath = normalizeWorkspaceRelativePath(end_frame_path, 'end_frame_path');
        const referenceImagePaths = normalizeWorkspaceRelativePathList(
          reference_image_paths,
          'reference_image_paths',
        );
        const inputVideoPath = normalizeWorkspaceRelativePath(input_video_path, 'input_video_path');

        if (selectedMode === 'text_to_video' && !normalizedPrompt) {
          throw new Error('prompt is required for text_to_video mode.');
        }
        if (selectedMode === 'frames_to_video' && !startFramePath) {
          throw new Error('start_frame_path is required for frames_to_video mode.');
        }
        if (selectedMode === 'references_to_video' && (!normalizedPrompt || referenceImagePaths.length === 0)) {
          throw new Error('prompt and at least one reference_image_paths entry are required for references_to_video mode.');
        }
        if (selectedMode === 'extend_video' && !inputVideoPath) {
          throw new Error('input_video_path is required for extend_video mode.');
        }

        const data = await generateVideoFn(
          {
            prompt: normalizedPrompt,
            mode: selectedMode,
            aspectRatio: aspect_ratio ?? '16:9',
            resolution: resolution ?? '720p',
            model: model ?? 'veo-3.1-fast-generate-preview',
            startFramePath,
            endFramePath,
            referenceImagePaths,
            inputVideoPath,
            isLooping: is_looping ?? false,
          },
          'pi-agent',
        );

        let resultText = 'Video generation started! This may take 3-10 minutes.\n\n';
        if (data.path) {
          resultText += `Video will be saved to: ${data.path}\n`;
        }
        if (data.mediaUrl) {
          resultText += `Media URL: ${data.mediaUrl}\n`;
        }

        return {
          content: [{ type: 'text', text: resultText }],
          details: data,
        };
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  };
}

async function executeQmdCommand(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BUN_INSTALL: process.env.BUN_INSTALL || '/data/cache/.bun',
  };

  const bunInstall = env.BUN_INSTALL || '/data/cache/.bun';
  const pathEntries = [path.join(bunInstall, 'bin'), env.PATH || ''].filter(Boolean);
  env.PATH = pathEntries.join(':');

  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile('qmd', args, { cwd, env, maxBuffer: 1024 * 1024 * 8 }, (error, stdout, stderr) => {
      if (error) {
        const execError = error as CommandExecutionError;
        execError.stdout = stdout;
        execError.stderr = stderr;
        reject(execError);
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

/**
 * Web fetch result for a single URL
 */
interface WebFetchResult {
  url: string;
  success: boolean;
  statusCode?: number;
  title?: string;
  content?: string;
  error?: string;
  truncated?: boolean;
  fetchTime: string;
}

/**
 * Fetch and extract readable content from URLs
 * Processes URLs sequentially to avoid container resource spikes
 */
async function fetchWebContent(
  urls: string[],
  timeoutPerUrl: number = 15,
  maxContentLength: number = 10000
): Promise<WebFetchResult[]> {
  const results: WebFetchResult[] = [];
  const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
  });
  turndownService.use(gfm);

  for (const url of urls) {
    const fetchTime = new Date().toISOString();
    
    try {
      // Validate URL
      let validatedUrl: URL;
      try {
        validatedUrl = new URL(url);
      } catch {
        results.push({
          url,
          success: false,
          error: 'Invalid URL format',
          fetchTime,
        });
        continue;
      }

      // Fetch with timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutPerUrl * 1000);
      
      const response = await fetch(validatedUrl.toString(), {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Canvas-Notebook/1.0)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        results.push({
          url,
          success: false,
          statusCode: response.status,
          error: `HTTP ${response.status}: ${response.statusText}`,
          fetchTime,
        });
        continue;
      }

      // Get HTML content
      const html = await response.text();
      
      // Parse with JSDOM
      const dom = new JSDOM(html, { url: validatedUrl.toString() });
      const document = dom.window.document;
      
      // Extract title
      const title = document.title?.trim() || 'No title';
      
      // Try Readability first
      const reader = new Readability(document);
      const article = reader.parse();
      
      let content: string;
      if (article?.content) {
        content = turndownService.turndown(article.content);
      } else {
        // Fallback: extract from body
        const body = document.querySelector('main, article, [role="main"], .content, #content') || document.body;
        // Remove script/style elements
        body.querySelectorAll('script, style, noscript, nav, header, footer, aside').forEach(el => el.remove());
        content = turndownService.turndown(body.innerHTML);
      }

      // Clean up content
      content = content
        .replace(/\[\\?\[\s*\\?\]\]\([^)]*\)/g, '')
        .replace(/ +/g, ' ')
        .replace(/\s+,/g, ',')
        .replace(/\s+\./g, '.')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      // Check if content is too short (likely JS-required)
      if (content.length < 200) {
        results.push({
          url,
          success: false,
          statusCode: response.status,
          title,
          error: 'Content too short - site may require JavaScript. Use browser-content tool.',
          fetchTime,
        });
        continue;
      }

      // Check if content needs truncation
      const truncated = content.length > maxContentLength;
      const finalContent = truncated 
        ? content.substring(0, maxContentLength) 
        : content;

      results.push({
        url,
        success: true,
        statusCode: response.status,
        title,
        content: finalContent,
        truncated,
        fetchTime,
      });

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      // Check if it's a timeout
      const isTimeout = errorMessage.toLowerCase().includes('timeout') || 
                      errorMessage.toLowerCase().includes('abort');
      
      results.push({
        url,
        success: false,
        error: isTimeout 
          ? `Timeout after ${timeoutPerUrl}s. Site may be slow or require JavaScript.` 
          : errorMessage,
        fetchTime,
      });
    }
  }

  return results;
}

function formatWebFetchResults(results: WebFetchResult[]): string {
  const successful = results.filter(r => r.success).length;
  const total = results.length;
  
  let markdown = `# Web Fetch Results (${successful}/${total} successful)\n\n`;
  
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    markdown += `## URL ${i + 1}: ${result.url}\n`;
    
    if (result.success) {
      markdown += `**Status**: ✅ ${result.statusCode} OK\n`;
      markdown += `**Title**: ${result.title}\n`;
      markdown += `**Fetched**: ${result.fetchTime}\n\n`;
      markdown += result.content;
      if (result.truncated) {
        markdown += '\n\n[...content truncated after 10,000 characters]';
      }
    } else {
      markdown += `**Status**: ❌ Failed\n`;
      if (result.statusCode) {
        markdown += `**HTTP Status**: ${result.statusCode}\n`;
      }
      markdown += `**Error**: ${result.error}\n`;
      if (result.title) {
        markdown += `**Title**: ${result.title}\n`;
      }
    }
    
    markdown += '\n\n---\n\n';
  }
  
  // Summary
  const failed = results.filter(r => !r.success).length;
  if (failed > 0) {
    markdown += `**Summary**: Successfully fetched ${successful} of ${total} URLs. ${failed} failed.\n`;
    markdown += '\nFor failed URLs requiring JavaScript, use browser-content or browser-tools.';
  }
  
  return markdown;
}

export function createWebFetchTool(): AgentTool {
  return {
    name: 'web_fetch',
    label: 'Fetching website content',
    description: 
      'Fetch and extract readable content from URLs using HTTP. Fast and lightweight (~50MB RAM). ' +
      'Use this FIRST for static HTML sites, blogs, documentation. Only falls back to browser-tools ' +
      'if JavaScript rendering is required. Max 10 URLs.',
    parameters: Type.Object({
      urls: Type.Array(
        Type.String({ description: 'URL to fetch (max 10 URLs total)' }),
        { maxItems: 10, description: 'Array of URLs to fetch content from (1-10 URLs)' }
      ),
      timeout: Type.Optional(
        Type.Number({ 
          description: 'Timeout per URL in seconds (default: 15, max: 60)', 
          default: 15,
          maximum: 60 
        })
      ),
      max_content_length: Type.Optional(
        Type.Number({ 
          description: 'Maximum characters per page (default: 10000)', 
          default: 10000,
          maximum: 50000 
        })
      ),
    }),
    execute: async (toolCallId, params) => {
      try {
        const { urls, timeout = 15, max_content_length = 10000 } = params as {
          urls: string[];
          timeout?: number;
          max_content_length?: number;
        };

        // Validate URLs array
        if (!Array.isArray(urls) || urls.length === 0) {
          return {
            content: [{ type: 'text', text: 'Error: urls must be a non-empty array of URLs' }],
            details: { error: 'Invalid urls parameter' },
          };
        }

        if (urls.length > 10) {
          return {
            content: [{ type: 'text', text: 'Error: Maximum 10 URLs allowed' }],
            details: { error: 'Too many URLs' },
          };
        }

        // Process URLs sequentially
        const results = await fetchWebContent(urls, timeout, max_content_length);
        const markdown = formatWebFetchResults(results);
        
        return {
          content: [{ type: 'text', text: markdown }],
          details: { results },
        };

      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return {
          content: [{ type: 'text', text: `Error fetching web content: ${message}` }],
          details: { error: message },
        };
      }
    },
  };
}

export function createRipgrepTool(): AgentTool {
  return {
    name: 'rg',
    label: 'Searching text with ripgrep',
    description: 'Searches file contents with ripgrep. Use this for fast text/content lookup across the workspace before falling back to bash.',
    parameters: Type.Object({
      pattern: Type.String({ description: 'Text or regex pattern to search for.' }),
      path: Type.Optional(Type.String({ description: 'Directory or file to search in. Absolute or workspace-relative. Defaults to /data/workspace.' })),
      glob: Type.Optional(Type.String({ description: 'Optional glob filter, for example "**/*.ts" or "*.md".' })),
      ignoreCase: Type.Optional(Type.Boolean({ description: 'Case-insensitive search when true.' })),
      hidden: Type.Optional(Type.Boolean({ description: 'Include hidden files when true.' })),
      maxResults: Type.Optional(Type.Number({ description: 'Maximum matches per file. Default: 50 (max 200).' })),
    }),
    execute: async (toolCallId, params) => {
      const {
        pattern,
        path: searchPath,
        glob,
        ignoreCase,
        hidden,
        maxResults,
      } = params as {
        pattern: string;
        path?: string;
        glob?: string;
        ignoreCase?: boolean;
        hidden?: boolean;
        maxResults?: number;
      };

      try {
        const targetPath = resolveAgentPath(searchPath || '.');
        const args = ['-n', '--color', 'never', '--no-heading'];
        if (ignoreCase) {
          args.push('-i');
        }
        if (hidden) {
          args.push('--hidden');
        }
        if (glob?.trim()) {
          args.push('-g', glob.trim());
        }
        args.push('--max-count', String(clampMaxResults(maxResults, 50, 200)));
        args.push(pattern, targetPath);

        const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          execFile('rg', args, { cwd: '/' }, (err, commandStdout, commandStderr) => {
            const errCode = (err as NodeJS.ErrnoException & { code?: number })?.code;
            if (errCode === 1) {
              resolve({ stdout: '', stderr: '' });
              return;
            }
            if (err) {
              reject(err);
              return;
            }
            resolve({ stdout: commandStdout, stderr: commandStderr });
          });
        });

        const matches = stdout.split('\n').filter(Boolean);
        return {
          content: [{ type: 'text', text: stdout || '(no matches found)' }],
          details: { args, stdout, stderr, matches },
        };
      } catch (error: unknown) {
        const execError = asCommandExecutionError(error);
        const message = [execError.stderr, execError.message].filter(Boolean).join('\n') || getErrorMessage(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message, stdout: execError.stdout, stderr: execError.stderr },
        };
      }
    },
  };
}

async function runQmdSearch(params: {
  query: string;
  mode?: unknown;
  collection?: unknown;
  limit?: unknown;
}): Promise<{
  summary: string;
  details: {
    mode: QmdSearchMode;
    collections: string[];
    results: ReturnType<typeof mergeQmdResults>;
    raw: Array<{ collection: string; stdout: string; stderr: string }>;
    stderr: string[];
  };
}> {
  const workspacePath = getWorkspacePath();
  const piConfig = await readPiRuntimeConfig();
  const mode = normalizeQmdMode(params.mode);
  const collections = normalizeQmdCollections(params.collection);
  const limit = typeof params.limit === 'number' && Number.isFinite(params.limit)
    ? Math.max(1, Math.min(Math.trunc(params.limit), 50))
    : 10;

  if (mode === 'query' && piConfig.qmd?.allowExpensiveQueryMode !== true) {
    throw new Error(
      'qmd query mode is disabled by default in Canvas Notebook because it can trigger model downloads and local builds. Set qmd.allowExpensiveQueryMode=true in the PI runtime config to enable it.',
    );
  }

  const rawOutputs: Array<{ collection: string; stdout: string; stderr: string }> = [];
  const parsedResults = [];

  for (const collection of collections) {
    const args = [mode, params.query, '--json', '-n', String(limit), '-c', collection];
    const { stdout, stderr } = await executeQmdCommand(args, workspacePath);
    rawOutputs.push({ collection, stdout, stderr });
    parsedResults.push(...normalizeQmdResults(extractFirstJsonArray(stdout), collection));
  }

  const mergedResults = mergeQmdResults(parsedResults);

  return {
    summary: formatQmdSearchSummary(mergedResults, mode),
    details: {
      mode,
      collections,
      results: mergedResults,
      raw: rawOutputs,
      stderr: rawOutputs.map((entry) => entry.stderr).filter(Boolean),
    },
  };
}

function createQmdTool(name: string, legacy = false): AgentTool {
  return {
    name,
    label: legacy ? 'Searching workspace (legacy qmd alias)' : 'Searching workspace',
    description: legacy
      ? 'Legacy alias for qmd. Searches the workspace with qmd using fast BM25 search by default. Prefer mode=search; use vsearch only after weak keyword results. query mode is intentionally disabled by default because it can trigger large local model downloads/builds.'
      : 'Searches the Canvas workspace with qmd. Use this for file/content lookup across workspace-text and workspace-derived collections. Default mode=search (fast BM25). Use vsearch only after weak keyword results. query mode is intentionally disabled by default because it can trigger large local model downloads/builds.',
    parameters: Type.Object({
      query: Type.String({ description: 'Search query' }),
      mode: Type.Optional(
        Type.Union([
          Type.Literal('search'),
          Type.Literal('vsearch'),
          Type.Literal('query'),
        ], { description: 'Search mode. Default: search. query is disabled unless qmd.allowExpensiveQueryMode is enabled in PI config.' }),
      ),
      collection: Type.Optional(
        Type.Union([
          Type.String({ description: 'Collection name. Defaults to workspace-text and workspace-derived.' }),
          Type.Array(Type.String(), { description: 'Collection names. Defaults to workspace-text and workspace-derived.' }),
        ]),
      ),
      limit: Type.Optional(Type.Number({ description: 'Maximum number of results. Default: 10 (max 50).' })),
    }),
    execute: async (toolCallId, params) => {
      try {
        const result = await runQmdSearch(params as {
          query: string;
          mode?: unknown;
          collection?: unknown;
          limit?: unknown;
        });

        return {
          content: [{ type: 'text', text: result.summary }],
          details: result.details,
        };
      } catch (error: unknown) {
        const execError = asCommandExecutionError(error);
        const stderr = [execError.stderr, execError.stdout].filter(Boolean).join('\n').trim();
        const message = stderr || execError.message || getErrorMessage(error);

        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: {
            error: message,
            stdout: execError.stdout,
            stderr: execError.stderr,
          },
        };
      }
    },
  };
}

/**
 * Registry for PI-compatible tools.
 */

export const piTools: AgentTool[] = [
  createWebFetchTool(),
  createRipgrepTool(),
  {
    name: 'ls',
    label: 'Listing directory',
    description: 'Lists files and directories. Use absolute paths (e.g. /data/canvas-agent) or relative paths from /data/workspace.',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'The path to list. Absolute or workspace-relative. Defaults to /data/workspace.' })),
    }),
    execute: async (toolCallId, params) => {
      try {
        const { path: dirPath } = params as { path?: string };
        const fullPath = resolveAgentPath(dirPath || '.');
        const entries = await fsPromises.readdir(fullPath, { withFileTypes: true });
        const files = await Promise.all(
          entries.map(async (entry) => {
            const entryFullPath = path.join(fullPath, entry.name);
            const stats = await fsPromises.stat(entryFullPath);
            return {
              name: entry.name,
              path: path.join(dirPath || '.', entry.name),
              type: entry.isDirectory() ? 'directory' : 'file',
              size: stats.size,
              modified: Math.floor(stats.mtimeMs / 1000),
            };
          })
        );
        const content = files.map(f => `${f.type === 'directory' ? '[DIR] ' : ''}${f.path}`).join('\n');
        return {
          content: [{ type: 'text', text: content || '(empty)' }],
          details: { files },
        };
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  },
  {
    name: 'read',
    label: 'Reading file',
    description: 'Reads the content of a file. Use absolute paths (e.g. /data/canvas-agent/AGENTS.md) or relative paths from /data/workspace.',
    parameters: Type.Object({
      path: Type.String({ description: 'Absolute path or workspace-relative path.' }),
    }),
    execute: async (toolCallId, params) => {
      const { path: filePath } = params as { path: string };
      try {
        const buffer = await fsPromises.readFile(resolveAgentPath(filePath));
        const image = imageContentForBuffer(filePath, buffer);
        if (image) {
          return {
            content: [image],
            details: { filePath, size: buffer.length, type: 'image' },
          };
        }
        return {
          content: [{ type: 'text', text: buffer.toString('utf8') }],
          details: { filePath, size: buffer.length },
        };
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  },
  {
    name: 'write',
    label: 'Writing file',
    description: 'Writes content to a file. Use absolute paths (e.g. /data/canvas-agent/memory.md) or relative paths from /data/workspace. Creates directories if needed.',
    parameters: Type.Object({
      path: Type.String({ description: 'Absolute path or workspace-relative path.' }),
      content: Type.String({ description: 'The content to write.' }),
    }),
    execute: async (toolCallId, params) => {
      const { path: filePath, content } = params as { path: string; content: string };
      try {
        const fullPath = resolveAgentPath(filePath);
        const dir = path.dirname(fullPath);
        await fsPromises.mkdir(dir, { recursive: true });
        await fsPromises.writeFile(fullPath, content, 'utf8');
        return {
          content: [{ type: 'text', text: `Successfully wrote ${content.length} bytes to ${filePath}` }],
          details: { filePath, size: content.length },
        };
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  },
  {
    name: 'bash',
    label: 'Executing command',
    // NOTE: cwd is intentionally '/' (not restricted to workspace) so the agent
    // can run commands in /data/canvas-agent or any other path it needs.
    description: 'Executes a bash command. Not restricted to workspace — use cd or absolute paths as needed.',
    parameters: Type.Object({
      command: Type.String({ description: 'The command to execute.' }),
    }),
    execute: async (toolCallId, params) => {
      const { command } = params as { command: string };
      try {
        const { stdout, stderr } = await execAsync(command, { cwd: '/' });
        const output = [stdout, stderr].filter(Boolean).join('\n');
        return {
          content: [{ type: 'text', text: output || '(no output)' }],
          details: { stdout, stderr },
        };
      } catch (error: unknown) {
        const execError = asCommandExecutionError(error);
        const output = [execError.stdout, execError.stderr, execError.message].filter(Boolean).join('\n');
        return {
          content: [{ type: 'text', text: output }],
          details: { error: execError.message, stdout: execError.stdout, stderr: execError.stderr },
        };
      }
    },
  },
  {
    name: 'grep',
    label: 'Searching files',
    description: 'Legacy text search alias. Prefer the dedicated `rg` tool for new searches.',
    parameters: Type.Object({
      pattern: Type.String({ description: 'The regex pattern to search for.' }),
      path: Type.Optional(Type.String({ description: 'The directory or file to search in. Absolute or workspace-relative. Defaults to /data/workspace.' })),
    }),
    execute: async (toolCallId, params) => {
      const { pattern, path: searchPath } = params as { pattern: string; path?: string };
      try {
        const targetPath = resolveAgentPath(searchPath || '.');
        // Use execFile to avoid shell injection via pattern or path
        const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          execFile('rg', ['-n', pattern, targetPath], { cwd: '/' }, (err, stdout, stderr) => {
            if (err && (err as NodeJS.ErrnoException & { code?: number }).code === 1) {
              resolve({ stdout: '', stderr: '' }); // no matches
            } else if (err) {
              reject(err);
            } else {
              resolve({ stdout, stderr });
            }
          });
        });
        const output = [stdout, stderr].filter(Boolean).join('\n');
        return {
          content: [{ type: 'text', text: output || '(no matches found)' }],
          details: { stdout, stderr },
        };
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  },
  {
    name: 'glob',
    label: 'Finding files',
    description: 'Finds files by name pattern. Use this or bash+find for path-based file discovery.',
    parameters: Type.Object({
      pattern: Type.String({ description: 'The glob pattern (e.g., "**/*.ts").' }),
      path: Type.Optional(Type.String({ description: 'The directory to search in. Absolute or workspace-relative. Defaults to /data/workspace.' })),
    }),
    execute: async (toolCallId, params) => {
      const { pattern, path: searchPath } = params as { pattern: string; path?: string };
      try {
        const searchRoot = resolveAgentPath(searchPath || '.');
        // Use execFile with argument array to avoid shell injection via pattern
        const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          execFile('find', [searchRoot, '-name', pattern], { cwd: '/' }, (err, stdout, stderr) => {
            if (err) reject(err); else resolve({ stdout, stderr });
          });
        });
        return {
          content: [{ type: 'text', text: stdout || '(no matches found)' }],
          details: { stdout, stderr },
        };
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  },
  // Canvas Notebook Skills
  createImageGenerationTool(),
  createVideoGenerationTool(),
  {
    name: 'ad_localization',
    label: 'Localizing ads',
    description: 'Localizes ad images for target markets using the local Canvas ad-localization service. Preserves layout, typography, and visual design - translates only the text. Use when user asks for: "localize this ad", "translate for market...", "adapt for country...". Output: workspace/nano-banana-ad-localizer/localizations/. The agent should use this local tool directly; no internal API token or manual env loading is required.',
    parameters: Type.Object({
      reference_image_path: Type.String({ description: 'Path to reference image (must be under nano-banana-ad-localizer/)' }),
      target_markets: Type.Array(Type.String(), { description: 'List of target markets (e.g., ["Germany", "France", "Japan"])' }),
      aspect_ratio: Type.Optional(Type.String({ description: 'Aspect ratio: 16:9, 1:1, 9:16, 4:3, 3:4. Default: 16:9' })),
      instructions: Type.Optional(Type.String({ description: 'Additional localization instructions' })),
    }),
    execute: async (toolCallId, params) => {
      const { reference_image_path, target_markets, aspect_ratio, instructions } = params as {
        reference_image_path: string;
        target_markets: string[];
        aspect_ratio?: string;
        instructions?: string;
      };
      try {
        const data = await localizeAd(
          {
            referenceImagePath: reference_image_path,
            targetMarkets: target_markets,
            aspectRatio: aspect_ratio || '16:9',
            model: 'gemini-3.1-flash-image-preview',
            customInstructions: instructions || '',
          },
          'pi-agent',
        );

        if (data.successCount === 0) {
          return {
            content: [{ type: 'text', text: `Error: ${AD_LOCALIZATION_ALL_FAILED_MESSAGE}` }],
            details: { error: AD_LOCALIZATION_ALL_FAILED_MESSAGE, data },
          };
        }

        return {
          content: [{ type: 'text', text: formatAdLocalizationText(data) }],
          details: data,
        };
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  },
  ...(isQmdEnabled() ? [
    {
      ...createQmdTool(QMD_CANONICAL_TOOL_NAME),
    },
    {
      ...createQmdTool('qmd_search', true),
    },
  ] : []),
];

import { getDynamicSkillTools } from '../skills/skill-tools';

const automationToolMetadata: { name: string; label: string; description: string }[] = [
  { name: 'list_automation_jobs', label: 'Listing automation jobs', description: 'Lists all automation jobs with their status and schedule information.' },
  { name: 'create_automation_job', label: 'Creating automation job', description: 'Creates a new scheduled automation job.' },
  { name: 'update_automation_job', label: 'Updating automation job', description: 'Updates an existing automation job.' },
  { name: 'delete_automation_job', label: 'Deleting automation job', description: 'Permanently deletes an automation job and all its run history.' },
  { name: 'trigger_automation_job', label: 'Triggering automation job', description: 'Manually triggers an automation job to run immediately.' },
];

export async function getPiToolMetadata(): Promise<{ name: string; label: string; description: string }[]> {
  return [
    ...piTools.map((tool) => ({
      name: tool.name,
      label: tool.label ?? tool.name,
      description: tool.description ?? '',
    })),
    ...automationToolMetadata,
  ];
}

export async function getPiTools(userId?: string): Promise<AgentTool[]> {
  const staticTools = piTools;

  const userAutomationTools: AgentTool[] = userId ? [
    {
      name: 'list_automation_jobs',
      label: 'Listing automation jobs',
      description: 'Lists all automation jobs with their status and schedule information. Use when user wants to see existing automations, check job status, or view scheduled workflows.',
      parameters: Type.Object({}),
      execute: async () => {
        try {
          const jobs = await listAutomationJobs(userId);
          const text = jobs.length === 0
            ? 'No automation jobs found'
            : jobs.map((job, index) => `--- Job ${index + 1} ---\n${formatAutomationJob(job)}`).join('\n\n');
          return {
            content: [{ type: 'text', text }],
            details: { jobs },
          };
        } catch (error: unknown) {
          const message = getErrorMessage(error);
          return {
            content: [{ type: 'text', text: `Error: ${message}` }],
            details: { error: message },
          };
        }
      },
    },
    {
      name: 'create_automation_job',
      label: 'Creating automation job',
      description: 'Creates a new scheduled automation job. Use when user wants to automate tasks, create scheduled workflows, or set up recurring jobs. Required: name (job name), prompt (the script to execute), schedule (when to run). Schedule types: once (date+time), daily (time), weekly (days+time), interval (every+unit). Optional: preferredSkill (auto/image_generation/video_generation/ad_localization/qmd), targetOutputPath (where to save results), workspaceContextPaths (context files), status (active/paused).',
      parameters: Type.Object({
        name: Type.String({ description: 'Name of the automation job (max 120 chars)' }),
        prompt: Type.String({ description: 'The script/prompt to execute when the job runs' }),
        schedule: Type.Object({
          kind: Type.String({ description: 'Schedule type: once, daily, weekly, interval' }),
          date: Type.Optional(Type.String({ description: 'For once: date in YYYY-MM-DD format' })),
          time: Type.Optional(Type.String({ description: 'For daily/weekly/once: time in HH:MM format' })),
          days: Type.Optional(Type.Array(Type.String(), { description: 'For weekly: array of days (mon, tue, wed, thu, fri, sat, sun)' })),
          every: Type.Optional(Type.Number({ description: 'For interval: number of units' })),
          unit: Type.Optional(Type.String({ description: 'For interval: minutes, hours, or days' })),
          timeZone: Type.Optional(Type.String({ description: 'Timezone (default: UTC)' })),
        }),
        preferredSkill: Type.Optional(Type.String({ description: 'Skill to use: auto, image_generation, video_generation, ad_localization, qmd' })),
        targetOutputPath: Type.Optional(Type.String({ description: 'Where to save job outputs (relative to workspace)' })),
        workspaceContextPaths: Type.Optional(Type.Array(Type.String(), { description: 'Array of file paths to include as context' })),
        status: Type.Optional(Type.String({ description: 'Job status: active (default) or paused' })),
      }),
      execute: async (toolCallId, params) => {
        const { name, prompt, schedule, preferredSkill, targetOutputPath, workspaceContextPaths, status } = params as {
          name: string;
          prompt: string;
          schedule: {
            kind: string;
            date?: string;
            time?: string;
            days?: string[];
            every?: number;
            unit?: string;
            timeZone?: string;
          };
          preferredSkill?: string;
          targetOutputPath?: string;
          workspaceContextPaths?: string[];
          status?: string;
        };
        try {
          const job = await createAutomationJob(
            {
              name: name.trim().slice(0, 120),
              prompt: prompt.trim().slice(0, 12000),
              schedule: normalizeAutomationSchedule(schedule),
              preferredSkill: normalizeAutomationPreferredSkill(preferredSkill),
              targetOutputPath: normalizeOptionalString(targetOutputPath)?.replace(/^\/+|^\.\/+/, '') || null,
              workspaceContextPaths: normalizeAutomationWorkspacePaths(workspaceContextPaths),
              status: normalizeAutomationStatus(status) || 'active',
            },
            userId,
          );
          return {
            content: [{ type: 'text', text: `Automation job created successfully\n\n${formatAutomationJob(job)}` }],
            details: { job },
          };
        } catch (error: unknown) {
          const message = getErrorMessage(error);
          return {
            content: [{ type: 'text', text: `Error: ${message}` }],
            details: { error: message },
          };
        }
      },
    },
    {
      name: 'update_automation_job',
      label: 'Updating automation job',
      description: 'Updates an existing automation job. Use to modify job parameters, pause/resume jobs, change schedules, or update prompts. Required: jobId. Optional: name, prompt, schedule, preferredSkill, targetOutputPath, workspaceContextPaths, status (active/paused).',
      parameters: Type.Object({
        jobId: Type.String({ description: 'ID of the job to update' }),
        name: Type.Optional(Type.String({ description: 'New name for the job' })),
        prompt: Type.Optional(Type.String({ description: 'New prompt/script' })),
        schedule: Type.Optional(Type.Object({
          kind: Type.String({ description: 'Schedule type: once, daily, weekly, interval' }),
          date: Type.Optional(Type.String({ description: 'For once: date in YYYY-MM-DD format' })),
          time: Type.Optional(Type.String({ description: 'For daily/weekly/once: time in HH:MM format' })),
          days: Type.Optional(Type.Array(Type.String(), { description: 'For weekly: array of days' })),
          every: Type.Optional(Type.Number({ description: 'For interval: number of units' })),
          unit: Type.Optional(Type.String({ description: 'For interval: minutes, hours, or days' })),
          timeZone: Type.Optional(Type.String({ description: 'Timezone' })),
        })),
        preferredSkill: Type.Optional(Type.String({ description: 'Skill to use' })),
        targetOutputPath: Type.Optional(Type.String({ description: 'Where to save outputs' })),
        workspaceContextPaths: Type.Optional(Type.Array(Type.String(), { description: 'Context file paths' })),
        status: Type.Optional(Type.String({ description: 'active or paused' })),
      }),
      execute: async (toolCallId, params) => {
        const { jobId, name, prompt, schedule, preferredSkill, targetOutputPath, workspaceContextPaths, status } = params as {
          jobId: string;
          name?: string;
          prompt?: string;
          schedule?: {
            kind: string;
            date?: string;
            time?: string;
            days?: string[];
            every?: number;
            unit?: string;
            timeZone?: string;
          };
          preferredSkill?: string;
          targetOutputPath?: string;
          workspaceContextPaths?: string[];
          status?: string;
        };
        try {
          const updatedJob = await updateAutomationJob(jobId, {
            name: normalizeOptionalString(name)?.slice(0, 120),
            prompt: normalizeOptionalString(prompt)?.slice(0, 12000),
            preferredSkill: normalizeAutomationPreferredSkill(preferredSkill),
            targetOutputPath: targetOutputPath === undefined
              ? undefined
              : normalizeOptionalString(targetOutputPath)?.replace(/^\/+|^\.\/+/, '') || null,
            workspaceContextPaths: normalizeAutomationWorkspacePaths(workspaceContextPaths),
            status: normalizeAutomationStatus(status),
            schedule: schedule ? normalizeAutomationSchedule(schedule) : undefined,
          });
          if (!updatedJob) {
            throw new Error(`Automation job "${jobId}" not found.`);
          }
          return {
            content: [{ type: 'text', text: `Automation job updated successfully\n\n${formatAutomationJob(updatedJob)}` }],
            details: { job: updatedJob },
          };
        } catch (error: unknown) {
          const message = getErrorMessage(error);
          return {
            content: [{ type: 'text', text: `Error: ${message}` }],
            details: { error: message },
          };
        }
      },
    },
    {
      name: 'delete_automation_job',
      label: 'Deleting automation job',
      description: 'Permanently deletes an automation job and all its run history. Use when user wants to remove a job completely. Required: jobId.',
      parameters: Type.Object({
        jobId: Type.String({ description: 'ID of the job to delete' }),
      }),
      execute: async (toolCallId, params) => {
        const { jobId } = params as { jobId: string };
        try {
          const deleted = await deleteAutomationJob(jobId);
          if (!deleted) {
            throw new Error(`Automation job "${jobId}" not found.`);
          }
          return {
            content: [{ type: 'text', text: 'Automation job deleted successfully' }],
            details: { jobId },
          };
        } catch (error: unknown) {
          const message = getErrorMessage(error);
          return {
            content: [{ type: 'text', text: `Error: ${message}` }],
            details: { error: message },
          };
        }
      },
    },
    {
      name: 'trigger_automation_job',
      label: 'Triggering automation job',
      description: 'Manually triggers an automation job to run immediately, regardless of its schedule. Use when user wants to run a job now instead of waiting for the next scheduled time. Required: jobId.',
      parameters: Type.Object({
        jobId: Type.String({ description: 'ID of the job to trigger' }),
      }),
      execute: async (toolCallId, params) => {
        const { jobId } = params as { jobId: string };
        try {
          const job = await getAutomationJob(jobId);
          if (!job) {
            throw new Error(`Automation job "${jobId}" not found.`);
          }
          const run = await scheduleAutomationJobRun(jobId, 'manual', new Date());
          return {
            content: [{ type: 'text', text: `Automation job triggered successfully\nRun ID: ${run.id}` }],
            details: { jobId, run },
          };
        } catch (error: unknown) {
          const message = getErrorMessage(error);
          return {
            content: [{ type: 'text', text: `Error: ${message}` }],
            details: { error: message },
          };
        }
      },
    },
  ] : [];

  let allTools: AgentTool[];
  try {
    const dynamicTools = await getDynamicSkillTools();
    const overriddenNames = new Set(userAutomationTools.map(t => t.name));
    const base = staticTools.filter(t => !overriddenNames.has(t.name));
    allTools = [...base, ...userAutomationTools, ...dynamicTools];
  } catch (error) {
    console.error('[ToolRegistry] Error loading dynamic skills:', error);
    const overriddenNames = new Set(userAutomationTools.map(t => t.name));
    allTools = [...staticTools.filter(t => !overriddenNames.has(t.name)), ...userAutomationTools];
  }

  try {
    const piConfig = await readPiRuntimeConfig();
    const activeProvider = piConfig.providers[piConfig.activeProvider];
    const enabledTools = activeProvider?.enabledTools;

    if (enabledTools && enabledTools.length > 0 && !isLegacyEnabledToolsValue(enabledTools)) {
      const allToolNames = allTools.map((t) => t.name);
      const enabledSet = resolveEnabledToolNames(allToolNames, enabledTools);
      allTools = allTools.filter((t) => enabledSet.has(t.name));
    }
  } catch (error) {
    console.error('[ToolRegistry] Error reading config for tool filtering, returning all tools:', error);
  }

  return allTools;
}
