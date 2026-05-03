import { type AgentTool } from '@mariozechner/pi-agent-core';
import { type ImageContent } from '@mariozechner/pi-ai';
import { Type } from 'typebox';
import { exec, execFile } from 'child_process';
import { promises as fsPromises } from 'fs';
import { createComposioTools } from '../composio/composio-tools';
import { isComposioConfigured } from '../composio/composio-client';
import { promisify } from 'util';
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
import { readPiRuntimeConfig } from '../agents/storage';
import { resolveEnabledToolNames, isLegacyEnabledToolsValue, getDefaultEnabledToolNames } from './enabled-tools';
import { PLANNING_MODE_ALLOWED_TOOLS } from './planning-mode';
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
  type AutomationWeekday,
  type FriendlySchedule,
} from '../automations/types';
import {
  executeStudioGeneration,
  type StudioGenerateRequest,
} from '../integrations/studio-generation-service';
import { listProducts } from '../integrations/studio-product-service';
import { listPersonas } from '../integrations/studio-persona-service';
import { listStyles } from '../integrations/studio-style-service';
import { StudioServiceError } from '../integrations/studio-errors';
import { getStudioOutputsRoot } from '../integrations/studio-workspace';
import { createBulkJob } from '../integrations/studio-bulk-service';
import { db } from '@/app/lib/db';
import {
  studioPresets,
} from '@/app/lib/db/schema';
import { eq } from 'drizzle-orm';


const execAsync = promisify(exec);


const IMAGE_EXTENSIONS: Record<string, string> = {
  '.gif':  'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg':  'image/jpeg',
  '.png':  'image/png',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
};

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

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

const VALID_AUTOMATION_DAYS: AutomationWeekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const VALID_AUTOMATION_INTERVAL_UNITS: AutomationIntervalUnit[] = ['minutes', 'hours', 'days'];

function formatAutomationJob(job: AutomationJobRecord): string {
  const schedule = JSON.stringify(job.schedule);
  const outputPath = job.targetOutputPath || job.effectiveTargetOutputPath;
  return [
    `ID: ${job.id}`,
    `Name: ${job.name}`,
    `Status: ${job.status}`,
    `Preferred skill: auto`,
    `Schedule: ${schedule}`,
    `Next run: ${job.nextRunAt || 'not scheduled'}`,
    `Last run: ${job.lastRunAt || 'never'}`,
    `Last run status: ${job.lastRunStatus || 'n/a'}`,
    `Output: ${outputPath}`,
  ].join('\n');
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

export function createStudioGenerateImageTool(
  deps: { executeStudioGenerationFn?: typeof executeStudioGeneration; userId?: string } = {},
): AgentTool {
  const executeFn = deps.executeStudioGenerationFn ?? executeStudioGeneration;
  const userId = deps.userId;

  return {
    name: 'studio_generate_image',
    label: 'Generating studio image',
    description:
      'Generates and edits images using the Studio system. The preferred tool for all image creation and reference-based image editing. ' +
      'Supports products, personas, styles, and presets for consistent branded content. ' +
      'For editing or matching existing images from file paths, put one or more image paths in extra_reference_urls; do not only mention the paths in the prompt. ' +
      'Output files are saved to /data/studio/outputs/ — absolute paths are returned so the agent can copy results to the workspace.',
    parameters: Type.Object({
      prompt: Type.String({ description: 'Text description of the image to generate.' }),
      product_ids: Type.Optional(Type.Array(Type.String(), { description: 'IDs of saved products to include as reference images (max 5).', maxItems: 5 })),
      persona_ids: Type.Optional(Type.Array(Type.String(), { description: 'IDs of saved personas to include as reference images (max 3).', maxItems: 3 })),
      style_ids: Type.Optional(Type.Array(Type.String(), { description: 'IDs of saved styles to apply as reference images (max 3).', maxItems: 3 })),
      preset_id: Type.Optional(Type.String({ description: 'ID of a studio preset to apply (lighting, camera, background settings).' })),
      aspect_ratio: Type.Optional(Type.String({ description: 'Aspect ratio: 1:1 (default), 16:9, 9:16, 4:3, 3:4.' })),
      count: Type.Optional(Type.Number({ description: 'Number of image variations (1-4). Default: 4.' })),
      provider: Type.Optional(Type.String({ description: 'Provider: gemini or openai. Default: gemini.' })),
      model: Type.Optional(Type.String({ description: 'Model ID. Options: gemini-3.1-flash-image-preview (default, best quality & features), gemini-3-pro-image-preview (pro quality & reasoning, Nano Banana Pro), gemini-2.5-flash-image (fast & affordable), gpt-image-2 (when provider is openai). If omitted, defaults to the best model for the selected provider.' })),
      image_size: Type.Optional(Type.String({ description: 'Image resolution for Gemini 3.x models. Options: "512" (0.5K, only gemini-3.1-flash), "1K" (default), "2K", "4K". Not supported by gemini-2.5-flash-image. Default: "1K".' })),
      quality: Type.Optional(Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high'), Type.Literal('auto')], { description: 'Image quality. OpenAI only. Default: auto.' })),
      output_format: Type.Optional(Type.Union([Type.Literal('png'), Type.Literal('jpeg'), Type.Literal('webp')], { description: 'Output format. OpenAI only. Default: png.' })),
      background: Type.Optional(Type.Union([Type.Literal('transparent'), Type.Literal('opaque'), Type.Literal('auto')], { description: 'Background treatment. OpenAI only. Default: auto.' })),
      source_output_id: Type.Optional(Type.String({ description: 'ID of a previous Studio output to use as the base image for editing or variation. Prefer this when you have the output ID.' })),
      extra_reference_urls: Type.Optional(Type.Array(Type.String(), { description: 'Reference image file paths or URLs to load as visual input for editing, variations, style matching, or image-to-image generation. Put every local reference image path here; do not only write paths in the prompt. Accepts Studio/workspace paths such as studio/outputs/studio-gen-xxx.png, /api/studio/media/studio/outputs/studio-gen-xxx.png, /api/studio/references/reference.png, studio/assets/references/reference.png, products/image.png, personas/image.png, styles/image.png, workspace paths like 09_asset-library/photo.png or /api/media/09_asset-library/photo.png, plus https image URLs.' })),
    }),
    execute: async (toolCallId, params) => {
      const p = params as StudioGenerateRequest;
      try {
        if (!userId) {
          throw new Error('User ID is required for studio generation.');
        }
        const result = await executeFn(userId, { ...p, mode: 'image' });
        const outputsRoot = getStudioOutputsRoot();
        const outputLines = result.outputs.map((o) => {
          const fullPath = path.join(outputsRoot, o.filePath);
          return `Output ${o.variationIndex + 1}:\n  File: ${fullPath}\n  URL:  ${o.mediaUrl}\n  ![studio-${o.variationIndex}](${o.mediaUrl})`;
        });
        const summary = [
          `Studio image generation completed (${result.outputs.length} output(s))`,
          '',
          ...outputLines,
          '',
          'To copy to workspace: bash cp <file-path> /data/workspace/<destination>',
        ].join('\n');
        return {
          content: [{ type: 'text', text: summary }],
          details: result,
        };
      } catch (error: unknown) {
        const message = error instanceof StudioServiceError
          ? error.userMessage
          : error instanceof Error
            ? error.message
            : 'An unexpected error occurred during studio image generation.';
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  };
}

export function createStudioGenerateVideoTool(
  deps: { executeStudioGenerationFn?: typeof executeStudioGeneration; userId?: string } = {},
): AgentTool {
  const executeFn = deps.executeStudioGenerationFn ?? executeStudioGeneration;
  const userId = deps.userId;

  return {
    name: 'studio_generate_video',
    label: 'Generating studio video',
    description:
      'Generates videos using the Studio system. The preferred tool for all video creation. Takes 3-10 minutes. ' +
      'Supports products, personas, styles, and presets for branded content. ' +
      'Providers: veo (default, Veo 3.x models) or bytedance (Seedance). ' +
      'For visual reference images from file paths, put one or more image paths in extra_reference_urls. Use start_frame_path/end_frame_path only for explicit start/end frame animation. ' +
      'Output files are saved to /data/studio/outputs/ — absolute paths are returned so the agent can copy results to the workspace.',
    parameters: Type.Object({
      prompt: Type.String({ description: 'Text description of the video to generate.' }),
      product_ids: Type.Optional(Type.Array(Type.String(), { description: 'IDs of saved products to include as reference images (max 5).', maxItems: 5 })),
      persona_ids: Type.Optional(Type.Array(Type.String(), { description: 'IDs of saved personas to include as reference images (max 3).', maxItems: 3 })),
      style_ids: Type.Optional(Type.Array(Type.String(), { description: 'IDs of saved styles to apply as reference images (max 3).', maxItems: 3 })),
      preset_id: Type.Optional(Type.String({ description: 'ID of a studio preset to apply.' })),
      aspect_ratio: Type.Optional(Type.String({ description: 'Aspect ratio: 16:9 (default) or 9:16.' })),
      provider: Type.Optional(Type.String({ description: 'Provider: veo (default) or bytedance.' })),
      model: Type.Optional(Type.String({ description: 'Model ID. Veo: veo-3.1-fast-generate-preview (default), veo-3.1-generate-preview, veo-3.1-lite-generate-preview, veo-3.0-generate-001, veo-3.0-fast-generate-001, veo-2.0-generate-001. Bytedance: bytedance/seedance-2.' })),
      resolution: Type.Optional(Type.Union([Type.Literal('480p'), Type.Literal('720p'), Type.Literal('1080p'), Type.Literal('4k')], { description: 'Resolution. Veo: 720p, 1080p, 4k. Bytedance: 480p, 720p, 1080p. Default: 720p.' })),
      duration: Type.Optional(Type.Number({ description: 'Duration in seconds. Veo: 4, 5, 6, or 8. Bytedance: 4–15. Default: 6.', minimum: 4, maximum: 15 })),
      start_frame_path: Type.Optional(Type.String({ description: 'Path or URL to the start frame. Accepts workspace-relative paths, /api/media/... URLs, Studio media paths, and /api/studio/media/... URLs. Use this only when the video should animate from a specific first frame; it enables frames_to_video mode.' })),
      end_frame_path: Type.Optional(Type.String({ description: 'Path or URL to the end frame. Accepts workspace-relative paths, /api/media/... URLs, Studio media paths, and /api/studio/media/... URLs. Optional for frames_to_video when the video should animate toward a specific final frame.' })),
      is_looping: Type.Optional(Type.Boolean({ description: 'Loop the video back to the start frame. Only for frames_to_video. Default: false.' })),
      person_generation: Type.Optional(Type.Union([Type.Literal('allow_all'), Type.Literal('allow_adult'), Type.Literal('dont_allow')], { description: 'Person generation policy. Veo only. Default: allow_all.' })),
      generate_audio: Type.Optional(Type.Boolean({ description: 'Generate audio. Bytedance only. Default: true.' })),
      web_search: Type.Optional(Type.Boolean({ description: 'Allow online search. Bytedance only. Default: false.' })),
      nsfw_checker: Type.Optional(Type.Boolean({ description: 'Enable NSFW checker. Bytedance only. Default: false.' })),
      source_output_id: Type.Optional(Type.String({ description: 'ID of a previous Studio output to use as a visual reference. Prefer this when you have the output ID.' })),
      extra_reference_urls: Type.Optional(Type.Array(Type.String(), { description: 'Reference image file paths or URLs to load as visual input for video generation. Put general reference images here; do not only write paths in the prompt. Accepts Studio/workspace paths such as studio/outputs/studio-gen-xxx.png, /api/studio/media/studio/outputs/studio-gen-xxx.png, /api/studio/references/reference.png, studio/assets/references/reference.png, products/image.png, personas/image.png, styles/image.png, workspace paths like 09_asset-library/photo.png or /api/media/09_asset-library/photo.png, plus https image URLs.' })),
    }),
    execute: async (toolCallId, params) => {
      const p = params as Record<string, unknown>;
      try {
        if (!userId) {
          throw new Error('User ID is required for studio generation.');
        }
        const request: StudioGenerateRequest = {
          prompt: p.prompt as string,
          mode: 'video',
          product_ids: p.product_ids as string[] | undefined,
          persona_ids: p.persona_ids as string[] | undefined,
          style_ids: p.style_ids as string[] | undefined,
          preset_id: p.preset_id as string | undefined,
          aspect_ratio: p.aspect_ratio as string | undefined,
          provider: p.provider as string | undefined,
          model: p.model as string | undefined,
          video_resolution: p.resolution as StudioGenerateRequest['video_resolution'],
          video_duration: p.duration as number | undefined,
          start_frame_path: p.start_frame_path as string | undefined,
          end_frame_path: p.end_frame_path as string | undefined,
          is_looping: p.is_looping as boolean | undefined,
          person_generation: p.person_generation as StudioGenerateRequest['person_generation'],
          video_generate_audio: p.generate_audio as boolean | undefined,
          video_web_search: p.web_search as boolean | undefined,
          video_nsfw_checker: p.nsfw_checker as boolean | undefined,
          source_output_id: p.source_output_id as string | undefined,
          extra_reference_urls: p.extra_reference_urls as string[] | undefined,
        };
        const result = await executeFn(userId, request);
        const outputsRoot = getStudioOutputsRoot();
        const outputLines = result.outputs.map((o) => {
          const fullPath = path.join(outputsRoot, o.filePath);
          return `Output:\n  File: ${fullPath}\n  URL:  ${o.mediaUrl}`;
        });
        const summary = [
          `Studio video generation completed (${result.outputs.length} output(s))`,
          '',
          ...outputLines,
          '',
          'To copy to workspace: bash cp <file-path> /data/workspace/<destination>',
        ].join('\n');
        return {
          content: [{ type: 'text', text: summary }],
          details: result,
        };
      } catch (error: unknown) {
        const message = error instanceof StudioServiceError
          ? error.userMessage
          : error instanceof Error
            ? error.message
            : 'An unexpected error occurred during studio video generation.';
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  };
}

export function createStudioEditImageTool(): AgentTool {
  return {
    name: 'studio_edit_image',
    label: 'Edit studio image (deprecated)',
    description: 'This tool is deprecated. Use studio_generate_image with source_output_id or extra_reference_urls instead.',
    parameters: Type.Object({
      source_output_id: Type.String({ description: 'Deprecated' }),
      instruction: Type.String({ description: 'Deprecated' }),
    }),
    execute: async () => {
      return {
        content: [{ type: 'text', text: 'studio_edit_image is deprecated. Use studio_generate_image with source_output_id or extra_reference_urls instead.' }],
        details: {},
      };
    },
  };
}

export function createStudioBulkGenerateTool(
  deps: { createBulkJobFn?: typeof createBulkJob; userId?: string } = {},
): AgentTool {
  const createFn = deps.createBulkJobFn ?? createBulkJob;
  const userId = deps.userId;

  return {
    name: 'studio_bulk_generate',
    label: 'Starting bulk generation',
    description:
      'Starts a bulk generation job that applies a studio preset and prompt to multiple ' +
      'products. Processes sequentially (max 20 products). Returns a job ID for tracking. ' +
      'Only one bulk job per user can run at a time.',
    parameters: Type.Object({
      product_ids: Type.Array(Type.String(), {
        description: 'Product IDs to generate for (max 20).',
        maxItems: 20,
      }),
      prompt: Type.String({
        description: 'Base prompt applied to all products.',
      }),
      preset_id: Type.Optional(Type.String({
        description: 'Studio preset to apply to all products.',
      })),
      aspect_ratio: Type.Optional(Type.String({ description: 'Default: 1:1' })),
      versions_per_product: Type.Optional(Type.Number({
        description: 'Variations per product (1-4). Default: 1',
      })),
    }),
    execute: async (toolCallId, params) => {
      const { product_ids, prompt, preset_id, aspect_ratio, versions_per_product } = params as {
        product_ids: string[];
        prompt: string;
        preset_id?: string;
        aspect_ratio?: string;
        versions_per_product?: number;
      };

      try {
        if (!userId) {
          throw new Error('User ID is required for bulk generation.');
        }

        const job = await createFn(userId, {
          productIds: product_ids,
          prompt,
          presetId: preset_id,
          aspectRatio: aspect_ratio,
          versionsPerProduct: versions_per_product,
        });

        return {
          content: [{ type: 'text', text: `Bulk generation started. Job ID: ${job.id}\nTotal line items: ${job.totalLineItems}\nStatus: ${job.status}` }],
          details: { jobId: job.id, totalLineItems: job.totalLineItems, status: job.status },
        };
      } catch (error: unknown) {
        const message = error instanceof StudioServiceError
          ? error.userMessage
          : error instanceof Error
            ? error.message
            : 'An unexpected error occurred during bulk generation.';
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  };
}

export function createStudioListProductsTool(
  deps: { listProductsFn?: typeof listProducts; userId?: string } = {},
): AgentTool {
  const listFn = deps.listProductsFn ?? listProducts;
  const userId = deps.userId;

  return {
    name: 'studio_list_products',
    label: 'Listing products',
    description: 'Lists all saved products in the Studio library. Returns product IDs, names, descriptions, and image count. Use this to find product IDs for studio_generate_image or studio_generate_video.',
    parameters: Type.Object({
      search: Type.Optional(Type.String({ description: 'Optional search term to filter products by name.' })),
    }),
    execute: async (toolCallId, params) => {
      const { search } = params as { search?: string };
      try {
        if (!userId) {
          throw new Error('User ID is required.');
        }
        const products = await listFn(userId, search);
        const text = products.length === 0
          ? 'No products found.'
          : products.map((p: { id: string; name: string; description?: string | null; imageCount: number }) =>
              `• ${p.name} (ID: ${p.id}) — ${p.imageCount} image(s)${p.description ? ` — ${p.description}` : ''}`
            ).join('\n');
        return {
          content: [{ type: 'text', text }],
          details: { products },
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Failed to list products.';
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  };
}

export function createStudioListPersonasTool(
  deps: { listPersonasFn?: typeof listPersonas; userId?: string } = {},
): AgentTool {
  const listFn = deps.listPersonasFn ?? listPersonas;
  const userId = deps.userId;

  return {
    name: 'studio_list_personas',
    label: 'Listing studio personas',
    description: 'Lists all saved personas/characters in the Studio library. Returns persona IDs, names, descriptions, and image counts. Use this to find persona IDs for studio_generate_image or studio_generate_video.',
    parameters: Type.Object({
      search: Type.Optional(Type.String({ description: 'Optional search term to filter personas by name.' })),
    }),
    execute: async (toolCallId, params) => {
      const { search } = params as { search?: string };
      try {
        if (!userId) {
          throw new Error('User ID is required.');
        }
        const personas = await listFn(userId, search);
        const text = personas.length === 0
          ? 'No personas found.'
          : personas.map((p: { id: string; name: string; description?: string | null; imageCount: number }) =>
              `• ${p.name} (ID: ${p.id}) — ${p.imageCount} image(s)${p.description ? ` — ${p.description}` : ''}`
            ).join('\n');
        return {
          content: [{ type: 'text', text }],
          details: { personas },
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Failed to list personas.';
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  };
}

export function createStudioListStylesTool(
  deps: { listStylesFn?: typeof listStyles; userId?: string } = {},
): AgentTool {
  const listFn = deps.listStylesFn ?? listStyles;
  const userId = deps.userId;

  return {
    name: 'studio_list_styles',
    label: 'Listing studio styles',
    description: 'Lists all saved visual styles/models in the Studio library. Returns style IDs, names, descriptions, and image counts. Use this to find style IDs for studio_generate_image or studio_generate_video.',
    parameters: Type.Object({
      search: Type.Optional(Type.String({ description: 'Optional search term to filter styles by name.' })),
    }),
    execute: async (toolCallId, params) => {
      const { search } = params as { search?: string };
      try {
        if (!userId) {
          throw new Error('User ID is required.');
        }
        const styles = await listFn(userId, search);
        const text = styles.length === 0
          ? 'No styles found.'
          : styles.map((s: { id: string; name: string; description?: string | null; imageCount: number }) =>
              `• ${s.name} (ID: ${s.id}) — ${s.imageCount} image(s)${s.description ? ` — ${s.description}` : ''}`
            ).join('\n');
        return {
          content: [{ type: 'text', text }],
          details: { styles },
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Failed to list styles.';
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  };
}

export function createStudioListPresetsTool(): AgentTool {
  return {
    name: 'studio_list_presets',
    label: 'Listing studio presets',
    description: 'Lists all available studio presets (visual settings). Returns preset IDs, names, descriptions, categories, tags, and the prompt fragments that make up each preset. Use this to find preset IDs for studio_generate_image or studio_generate_video.',
    parameters: Type.Object({
      category: Type.Optional(Type.String({ description: 'Filter by category: fashion, product, food, lifestyle, etc.' })),
    }),
    execute: async (toolCallId, params) => {
      const { category } = params as { category?: string };
      try {
        const presets = await db.select({
          id: studioPresets.id,
          name: studioPresets.name,
          description: studioPresets.description,
          category: studioPresets.category,
          tags: studioPresets.tags,
          blocks: studioPresets.blocks,
          isDefault: studioPresets.isDefault,
        })
          .from(studioPresets)
          .where(category
            ? eq(studioPresets.category, category)
            : eq(studioPresets.isDefault, true),
          );

        const text = presets.length === 0
          ? 'No studio presets found.'
          : presets.map((p) => {
              let tags: string[] = [];
              try { tags = JSON.parse(p.tags ?? '[]'); } catch { /* ignore */ }

              let fragments: string[] = [];
              try {
                const blocks: Array<{ promptFragment?: string }> = JSON.parse(p.blocks ?? '[]');
                fragments = blocks.map((b) => b.promptFragment).filter((f): f is string => !!f);
              } catch { /* ignore */ }

              const lines = [
                `• ${p.name} (ID: ${p.id}) [${p.category || 'uncategorized'}]${p.description ? ` — ${p.description}` : ''}`,
                tags.length > 0 ? `  Tags: ${tags.join(', ')}` : '',
                fragments.length > 0 ? `  Prompt: ${fragments.join(' | ')}` : '',
              ];
              return lines.filter(Boolean).join('\n');
            }).join('\n\n');

        return {
          content: [{ type: 'text', text }],
          details: { presets },
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Failed to list presets.';
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  };
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
        const effectiveDir = dirPath || '/data/workspace';
        const fullPath = resolveAgentPath(effectiveDir);
        const entries = await fsPromises.readdir(fullPath, { withFileTypes: true });
        const files = await Promise.all(
          entries.map(async (entry) => {
            const entryFullPath = path.join(fullPath, entry.name);
            const stats = await fsPromises.stat(entryFullPath);
            return {
              name: entry.name,
              path: path.join(effectiveDir, entry.name),
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
          execFile('rg', ['--files', '-g', pattern, searchRoot], { cwd: '/' }, (err, stdout, stderr) => {
            const errCode = (err as NodeJS.ErrnoException & { code?: number })?.code;
            if (errCode === 1) {
              resolve({ stdout: '', stderr: '' });
            } else if (err) {
              reject(err);
            } else {
              resolve({ stdout, stderr });
            }
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
  createStudioListPresetsTool(),
];

export type PiToolGroup = 'Core' | 'Studio' | 'Automation' | 'Composio';

export type PiToolMetadata = {
  name: string;
  label: string;
  description: string;
  group: PiToolGroup;
  parameters: string[];
  planningModeAllowed: boolean;
  defaultEnabled: boolean;
  notes: string[];
};

function requireToolUserId(userId: string | undefined, toolLabel: string): string {
  if (!userId) {
    throw new Error(`User ID is required for ${toolLabel}.`);
  }
  return userId;
}

function createUserScopedTools(userId?: string): AgentTool[] {
  return [
    {
      name: 'list_automation_jobs',
      label: 'Listing automation jobs',
      description: 'Lists all automation jobs with their status and schedule information. Use when user wants to see existing automations, check job status, or view scheduled workflows.',
      parameters: Type.Object({}),
      execute: async () => {
        try {
          const scopedUserId = requireToolUserId(userId, 'automation tools');
          const jobs = await listAutomationJobs(scopedUserId);
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
      description: 'Creates a new scheduled automation job. Use when user wants to automate tasks, create scheduled workflows, or set up recurring jobs. Required: name (job name), prompt (the script to execute), schedule (when to run). Schedule types: once (date+time), daily (time), weekly (days+time), interval (every+unit). Optional: targetOutputPath (where to save results), workspaceContextPaths (context files), status (active/paused).',
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
        targetOutputPath: Type.Optional(Type.String({ description: 'Where to save job outputs (relative to workspace)' })),
        workspaceContextPaths: Type.Optional(Type.Array(Type.String(), { description: 'Array of file paths to include as context' })),
        status: Type.Optional(Type.String({ description: 'Job status: active (default) or paused' })),
      }),
      execute: async (toolCallId, params) => {
        const { name, prompt, schedule, targetOutputPath, workspaceContextPaths, status } = params as {
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
          targetOutputPath?: string;
          workspaceContextPaths?: string[];
          status?: string;
        };
        try {
          const scopedUserId = requireToolUserId(userId, 'automation tools');
          const job = await createAutomationJob(
            {
              name: name.trim().slice(0, 120),
              prompt: prompt.trim().slice(0, 12000),
              schedule: normalizeAutomationSchedule(schedule),
              targetOutputPath: normalizeOptionalString(targetOutputPath)?.replace(/^\/+|^\.\/+/, '') || null,
              workspaceContextPaths: normalizeAutomationWorkspacePaths(workspaceContextPaths),
              status: normalizeAutomationStatus(status) || 'active',
            },
            scopedUserId,
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
      description: 'Updates an existing automation job. Use to modify job parameters, pause/resume jobs, change schedules, or update prompts. Required: jobId. Optional: name, prompt, schedule, targetOutputPath, workspaceContextPaths, status (active/paused).',
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
        targetOutputPath: Type.Optional(Type.String({ description: 'Where to save outputs' })),
        workspaceContextPaths: Type.Optional(Type.Array(Type.String(), { description: 'Context file paths' })),
        status: Type.Optional(Type.String({ description: 'active or paused' })),
      }),
      execute: async (toolCallId, params) => {
        const { jobId, name, prompt, schedule, targetOutputPath, workspaceContextPaths, status } = params as {
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
          targetOutputPath?: string;
          workspaceContextPaths?: string[];
          status?: string;
        };
        try {
          requireToolUserId(userId, 'automation tools');
          const updatedJob = await updateAutomationJob(jobId, {
            name: normalizeOptionalString(name)?.slice(0, 120),
            prompt: normalizeOptionalString(prompt)?.slice(0, 12000),
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
          requireToolUserId(userId, 'automation tools');
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
          requireToolUserId(userId, 'automation tools');
          const job = await getAutomationJob(jobId);
          if (!job) {
            throw new Error(`Automation job "${jobId}" not found.`);
          }
          const run = await scheduleAutomationJobRun(jobId, 'manual', new Date());
          if (!run) {
            return {
              content: [{ type: 'text', text: 'Automation already has an in-flight run.' }],
              details: { jobId, skipped: true },
            };
          }
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
    createStudioGenerateImageTool({ userId }),
    createStudioGenerateVideoTool({ userId }),
    createStudioEditImageTool(),
    createStudioBulkGenerateTool({ userId }),
    createStudioListProductsTool({ userId }),
    createStudioListPersonasTool({ userId }),
    createStudioListStylesTool({ userId }),
  ];
}

function getToolGroup(toolName: string): PiToolGroup {
  if (toolName.startsWith('studio_')) return 'Studio';
  if (toolName.includes('automation_job')) return 'Automation';
  if (toolName.startsWith('COMPOSIO_') || toolName === 'composio_execute') return 'Composio';
  return 'Core';
}

function getParameterType(schema: Record<string, unknown>): string {
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.type === 'array') return 'array';
  if (schema.type === 'object') return 'object';
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map((item) => getParameterType(item as Record<string, unknown>)).join(' | ');
  return typeof schema.type === 'string' ? schema.type : 'value';
}

function summarizeToolParameters(parameters: unknown): string[] {
  if (!parameters || typeof parameters !== 'object') {
    return [];
  }

  const schema = parameters as {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  const properties = schema.properties || {};
  const required = new Set(schema.required || []);

  return Object.entries(properties).map(([name, property]) => {
    const optional = required.has(name) ? '' : 'optional ';
    const type = getParameterType(property);
    const description = typeof property.description === 'string' ? ` - ${property.description}` : '';
    return `${name}: ${optional}${type}${description}`;
  });
}

function getToolNotes(tool: AgentTool, group: PiToolGroup): string[] {
  const notes: string[] = [];

  if (group === 'Studio') {
    notes.push('Uses Studio services and may read/write Studio library or output files.');
  }
  if (group === 'Automation') {
    notes.push('May create, update, delete, or trigger scheduled automation jobs.');
  }
if (['bash', 'terminal', 'rg', 'glob', 'grep', 'ls'].includes(tool.name)) {
    notes.push('May execute local shell commands or inspect local files.');
  }
  if (['write', 'edit', 'create_file', 'delete_file', 'studio_generate_image', 'studio_generate_video', 'studio_bulk_generate'].includes(tool.name)) {
    notes.push('May write files or create generated media.');
  }
  if (['web_fetch', 'studio_generate_image', 'studio_generate_video', 'studio_bulk_generate'].includes(tool.name)) {
    notes.push('May call external services or require configured API keys.');
  }
  if (['studio_generate_image', 'studio_generate_video', 'studio_bulk_generate'].includes(tool.name)) {
    notes.push('Can run for an extended time.');
  }
  if (group === 'Composio') {
    notes.push('May call external apps via Composio. Requires COMPOSIO_API_KEY and connected app accounts.');
  }

  return notes.length > 0 ? notes : ['Read-only or low-side-effect utility under normal use.'];
}

export function buildPiToolRegistry(userId?: string): AgentTool[] {
  const userScopedTools = createUserScopedTools(userId);
  const overriddenNames = new Set(userScopedTools.map((t) => t.name));
  const coreTools = piTools.filter((t) => !overriddenNames.has(t.name));
  return [...coreTools, ...userScopedTools];
}

export async function buildPiToolRegistryAsync(userId?: string): Promise<AgentTool[]> {
  const userScopedTools = createUserScopedTools(userId);
  const overriddenNames = new Set(userScopedTools.map((t) => t.name));
  const coreTools = piTools.filter((t) => !overriddenNames.has(t.name));
  const composioConfigured = await isComposioConfigured();
  const composioTools = composioConfigured ? createComposioTools() : [];
  return [...coreTools, ...userScopedTools, ...composioTools];
}

export async function getPiToolMetadata(): Promise<PiToolMetadata[]> {
  const allTools = await buildPiToolRegistryAsync();
  const allToolNames = allTools.map((tool) => tool.name);
  const defaultEnabledSet = getDefaultEnabledToolNames(allToolNames);

  return allTools.map((tool) => {
    const group = getToolGroup(tool.name);
    return {
      name: tool.name,
      label: tool.label ?? tool.name,
      description: tool.description ?? '',
      group,
      parameters: summarizeToolParameters(tool.parameters),
      planningModeAllowed: PLANNING_MODE_ALLOWED_TOOLS.has(tool.name),
      defaultEnabled: defaultEnabledSet.has(tool.name),
      notes: getToolNotes(tool, group),
    };
  });
}

export async function getPiTools(userId?: string): Promise<AgentTool[]> {
  let allTools = await buildPiToolRegistryAsync(userId);

  try {
    const piConfig = await readPiRuntimeConfig();
    const activeProvider = piConfig.providers[piConfig.activeProvider];
    const enabledTools = activeProvider?.enabledTools;

    const allToolNames = allTools.map((t) => t.name);

    if (enabledTools && enabledTools.length > 0 && !isLegacyEnabledToolsValue(enabledTools)) {
      // User has explicitly configured tool preferences — apply them
      const enabledSet = resolveEnabledToolNames(allToolNames, enabledTools);
      allTools = allTools.filter((t) => enabledSet.has(t.name));
    } else {
      // No user config yet (default state) — exclude disabled-by-default tools
      const defaultEnabledSet = getDefaultEnabledToolNames(allToolNames);
      allTools = allTools.filter((t) => defaultEnabledSet.has(t.name));
    }
  } catch (error) {
    console.error('[ToolRegistry] Error reading config for tool filtering, returning default tools:', error);
    // Fallback: exclude disabled-by-default tools even on error
    const allToolNames = allTools.map((t) => t.name);
    const defaultEnabledSet = getDefaultEnabledToolNames(allToolNames);
    allTools = allTools.filter((t) => defaultEnabledSet.has(t.name));
  }

  return allTools;
}
