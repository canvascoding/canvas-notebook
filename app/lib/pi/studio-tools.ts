import { type AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import path from 'path';
import { promises as fsPromises } from 'fs';
import {
  executeStudioGeneration,
  type StudioGenerateRequest,
} from '@/app/lib/integrations/studio-generation-service';
import { listProducts } from '@/app/lib/integrations/studio-product-service';
import { listPersonas } from '@/app/lib/integrations/studio-persona-service';
import { listStyles } from '@/app/lib/integrations/studio-style-service';
import {
  resolveStudioFilePath,
} from '@/app/lib/integrations/studio-workspace';
import { toPreviewUrl } from '@/app/lib/utils/media-url';
import { createBulkJob } from '@/app/lib/integrations/studio-bulk-service';
import { listPresets } from '@/app/lib/integrations/studio-preset-service';
import { createPersistedStudioScope, type StudioScope } from '@/app/lib/integrations/studio-scope';
import { ensureStudioWorkspaceFilesMigrated } from '@/app/lib/integrations/studio-workspace-file-migration';
import {
  MAX_AUDIO_TRANSCRIPTION_BYTES,
  transcribeAudio,
} from '@/app/lib/integrations/audio-transcription-service';
import {
  assertAgentPathAllowed,
  audioMimeTypeForPath,
  getErrorMessage,
  normalizeOptionalString,
  resolveAgentPath,
  throwIfAborted,
} from '@/app/lib/pi/tool-runtime-helpers';
import { getAgentExecutionContext } from '@/app/lib/pi/agent-execution-context';

function requireStudioToolScope(userId?: string): StudioScope {
  const context = getAgentExecutionContext();
  const actorUserId = userId ?? context?.userId;
  if (!context || !actorUserId || context.userId !== actorUserId) {
    throw new Error('Active workspace context is required for Studio tools.');
  }
  if (!context.organizationId) {
    throw new Error('Studio requires a persisted workspace.');
  }
  return createPersistedStudioScope({
    actorUserId,
    organizationId: context.organizationId,
    customerId: context.customerId,
    projectId: context.projectId,
    workspaceId: context.workspaceId,
  });
}

async function prepareStudioToolScope(userId?: string): Promise<StudioScope> {
  const scope = requireStudioToolScope(userId);
  await ensureStudioWorkspaceFilesMigrated(scope);
  return scope;
}

function requireStudioOutputAbsolutePath(filePath: string): string {
  const absolutePath = resolveStudioFilePath(filePath);
  if (!absolutePath) throw new Error(`Invalid Studio output path: ${filePath}`);
  return absolutePath;
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
      'For multiple different images, issue separate studio_generate_image calls in the same assistant turn; they run concurrently with a shared system limit of five active image generations. Use count only for variations of the same prompt. ' +
      'Supports products, personas, styles, and presets for consistent branded content. ' +
      'For editing or matching existing images from file paths, put one or more image paths in extra_reference_urls; do not only mention the paths in the prompt. ' +
      'Output files are saved in the active workspace\'s Studio storage — exact workspace-scoped reference and absolute paths are returned.',
    parameters: Type.Object({
      prompt: Type.String({ description: 'Text description of the image to generate.' }),
      product_ids: Type.Optional(Type.Array(Type.String(), { description: 'IDs of saved products to include as reference images (max 5).', maxItems: 5 })),
      persona_ids: Type.Optional(Type.Array(Type.String(), { description: 'IDs of saved personas to include as reference images (max 3).', maxItems: 3 })),
      style_ids: Type.Optional(Type.Array(Type.String(), { description: 'IDs of saved styles to apply as reference images (max 3).', maxItems: 3 })),
      preset_id: Type.Optional(Type.String({ description: 'ID of a studio preset to apply (lighting, camera, background settings).' })),
      aspect_ratio: Type.Optional(Type.String({ description: 'Aspect ratio: 1:1 (default), 16:9, 9:16, 4:3, 3:4.' })),
      count: Type.Optional(Type.Number({ description: 'Number of image variations (1-4). Default: 1.' })),
      provider: Type.Optional(Type.String({ description: 'Provider: gemini or openai. Default: gemini.' })),
      model: Type.Optional(Type.String({ description: 'Model ID. Options: gemini-3.1-flash-image (default, best quality & features), gemini-3-pro-image (pro quality & reasoning, Nano Banana Pro), gpt-image-2 (when provider is openai). If omitted, defaults to the best model for the selected provider.' })),
      image_size: Type.Optional(Type.String({ description: 'Image resolution for Gemini models. Options: "512" (0.5K, only gemini-3.1-flash), "1K" (default), "2K", "4K". Default: "1K".' })),
      quality: Type.Optional(Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high'), Type.Literal('auto')], { description: 'Image quality. OpenAI only. Default: auto.' })),
      output_format: Type.Optional(Type.Union([Type.Literal('png'), Type.Literal('jpeg'), Type.Literal('webp')], { description: 'Output format. OpenAI only. Default: png. For a transparent background, use png (recommended) or webp; jpeg does not support transparency.' })),
      background: Type.Optional(Type.Union([Type.Literal('transparent'), Type.Literal('opaque'), Type.Literal('auto')], { description: 'Background treatment. OpenAI only. Default: auto. To request a transparent image, set this to transparent and set output_format to png (recommended) or webp.' })),
      source_output_id: Type.Optional(Type.String({ description: 'ID of a previous Studio output to use as the base image for editing or variation. Prefer this when you have the output ID.' })),
      extra_reference_urls: Type.Optional(Type.Array(Type.String(), { description: 'Reference image file paths or URLs to load as visual input for editing, variations, style matching, or image-to-image generation. Put every local reference image path here; do not only write paths in the prompt. Accepts exact workspace-scoped Studio paths returned by Studio tools, /api/studio/media/... and /api/studio/references/... URLs, products/image.png, personas/image.png, styles/image.png, workspace paths like 09_asset-library/photo.png or /api/media/09_asset-library/photo.png, plus https image URLs.' })),
    }),
    execute: async (toolCallId, params) => {
      const p = params as StudioGenerateRequest;
      if (!userId) {
        throw new Error('User ID is required for studio generation.');
      }
      const scope = await prepareStudioToolScope(userId);
      const result = await executeFn(scope, { ...p, mode: 'image' });
      const outputLines = result.outputs.map((o) => {
        const fullPath = requireStudioOutputAbsolutePath(o.filePath);
        const referencePath = o.filePath;
        const previewUrl = toPreviewUrl(o.filePath, 960, { workspaceId: scope.workspaceId });
        const markdownImage = `![studio-${o.variationIndex}](${o.mediaUrl})`;
        return [
          `Output ${o.variationIndex + 1}:`,
          `  Output ID: ${o.id}`,
          `  Absolute copy source path: ${fullPath}`,
          `  Studio reference path for later edits: ${referencePath}`,
          `  Browser render URL for Markdown: ${o.mediaUrl}`,
          `  Thumbnail preview URL (UI only): ${previewUrl}`,
          `  Markdown image (copy exactly): ${markdownImage}`,
        ].join('\n');
      });
      const summary = [
        `Studio image generation completed (${result.outputs.length} output(s))`,
        '',
        ...outputLines,
        '',
        'Important for the final answer: embed the generated image by copying the Markdown image line exactly. Do not invent, shorten, slugify, or rewrite the image URL; relative filenames like ente-statt-affe.jpg will not render in the chat.',
        'Important for file operations: use the absolute copy source path with copy_path when copying the generated file into the active workspace. The browser render URL and thumbnail preview URL are not filesystem paths.',
        '',
        'To copy to workspace: copy_path with sourcePath=<absolute copy source path> and destinationPath=<workspace-relative destination>.',
      ].join('\n');
      return {
        content: [{ type: 'text', text: summary }],
        details: result,
      };
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
      'For multiple different videos, issue separate studio_generate_video calls in the same assistant turn; they run concurrently with a shared system limit of two active video generations. ' +
      'Supports products, personas, styles, and presets for branded content. ' +
      'Providers: veo (default, Veo 3.1 models) or bytedance (Seedance). ' +
      'For visual reference images from file paths, put image paths in extra_reference_urls (Veo max 3, Seedance max 9). For Seedance video/audio references, use reference_video_urls and reference_audio_urls. Use start_frame_path/end_frame_path only for explicit start/end frame animation. ' +
      'Output files are saved in the active workspace\'s Studio storage — exact workspace-scoped reference and absolute paths are returned.',
    parameters: Type.Object({
      prompt: Type.String({ description: 'Text description of the video to generate.' }),
      product_ids: Type.Optional(Type.Array(Type.String(), { description: 'IDs of saved products to include as reference images (max 5).', maxItems: 5 })),
      persona_ids: Type.Optional(Type.Array(Type.String(), { description: 'IDs of saved personas to include as reference images (max 3).', maxItems: 3 })),
      style_ids: Type.Optional(Type.Array(Type.String(), { description: 'IDs of saved styles to apply as reference images (max 3).', maxItems: 3 })),
      preset_id: Type.Optional(Type.String({ description: 'ID of a studio preset to apply.' })),
      aspect_ratio: Type.Optional(Type.String({ description: 'Aspect ratio: 16:9 (default) or 9:16.' })),
      provider: Type.Optional(Type.String({ description: 'Provider: veo (default) or bytedance.' })),
      model: Type.Optional(Type.String({ description: 'Model ID. Veo: veo-3.1-fast-generate-preview (default), veo-3.1-generate-preview, veo-3.1-lite-generate-preview. Bytedance: bytedance/seedance-2.' })),
      resolution: Type.Optional(Type.Union([Type.Literal('480p'), Type.Literal('720p'), Type.Literal('1080p'), Type.Literal('4k')], { description: 'Resolution. Veo: 720p, 1080p, 4k. Bytedance: 480p, 720p, 1080p. Default: 720p.' })),
      duration: Type.Optional(Type.Number({ description: 'Duration in seconds. Veo: 4, 6, or 8. Bytedance: 4–15. Default: 6.', minimum: 4, maximum: 15 })),
      start_frame_path: Type.Optional(Type.String({ description: 'Path or URL to the start frame. Accepts workspace-relative paths, /api/media/... URLs, Studio media paths, and /api/studio/media/... URLs. Use this only when the video should animate from a specific first frame; it enables frames_to_video mode.' })),
      end_frame_path: Type.Optional(Type.String({ description: 'Path or URL to the end frame. Accepts workspace-relative paths, /api/media/... URLs, Studio media paths, and /api/studio/media/... URLs. Optional for frames_to_video when the video should animate toward a specific final frame.' })),
      is_looping: Type.Optional(Type.Boolean({ description: 'Loop the video back to the start frame. Only for frames_to_video. Default: false.' })),
      person_generation: Type.Optional(Type.Union([Type.Literal('allow_all'), Type.Literal('allow_adult'), Type.Literal('dont_allow')], { description: 'Person generation policy. Veo only. Default: allow_all.' })),
      generate_audio: Type.Optional(Type.Boolean({ description: 'Generate audio. Bytedance only. Default: true.' })),
      web_search: Type.Optional(Type.Boolean({ description: 'Allow online search. Bytedance only. Default: false.' })),
      nsfw_checker: Type.Optional(Type.Boolean({ description: 'Enable NSFW checker. Bytedance only. Default: false.' })),
      source_output_id: Type.Optional(Type.String({ description: 'ID of a previous Studio output to use as a visual reference. Prefer this when you have the output ID.' })),
      extra_reference_urls: Type.Optional(Type.Array(Type.String(), { description: 'Reference image file paths or URLs to load as visual input for video generation. Put general reference images here; do not only write paths in the prompt. Veo uses up to 3 images. Seedance uses up to 9 images. Accepts exact workspace-scoped Studio paths returned by Studio tools, /api/studio/media/... and /api/studio/references/... URLs, products/image.png, personas/image.png, styles/image.png, workspace paths like 09_asset-library/photo.png or /api/media/09_asset-library/photo.png, plus https image URLs.', maxItems: 9 })),
      reference_video_urls: Type.Optional(Type.Array(Type.String(), { description: 'Seedance only. Reference video file paths or URLs for multimodal reference-to-video. Accepts Studio/workspace video paths or HTTPS video URLs. Max 3.' })),
      reference_audio_urls: Type.Optional(Type.Array(Type.String(), { description: 'Seedance only. Reference audio file paths or URLs for multimodal reference-to-video. Accepts Studio/workspace audio paths or HTTPS audio URLs. Max 3.' })),
    }),
    execute: async (toolCallId, params) => {
      const p = params as Record<string, unknown>;
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
        video_reference_urls: p.reference_video_urls as string[] | undefined,
        audio_reference_urls: p.reference_audio_urls as string[] | undefined,
      };
      const scope = await prepareStudioToolScope(userId);
      const result = await executeFn(scope, request);
      const outputLines = result.outputs.map((o) => {
        const fullPath = requireStudioOutputAbsolutePath(o.filePath);
        return `Output:\n  File: ${fullPath}\n  URL:  ${o.mediaUrl}`;
      });
      const summary = [
        `Studio video generation completed (${result.outputs.length} output(s))`,
        '',
        ...outputLines,
        '',
        'To copy to workspace: copy_path with sourcePath=<absolute copy source path> and destinationPath=<workspace-relative destination>.',
      ].join('\n');
      return {
        content: [{ type: 'text', text: summary }],
        details: result,
      };
    },
  };
}

export function createStudioGenerateSoundTool(
  deps: { executeStudioGenerationFn?: typeof executeStudioGeneration; userId?: string } = {},
): AgentTool {
  const executeFn = deps.executeStudioGenerationFn ?? executeStudioGeneration;
  const userId = deps.userId;

  return {
    name: 'studio_generate_sound',
    label: 'Generating studio sound',
    description:
      'Generates music or sound with Gemini Lyria 3 through Studio. The preferred tool for all music and sound generation. ' +
      'Supports up to 10 image references in extra_reference_urls so music can be inspired by visual mood, colors, products, personas, styles, or existing Studio outputs. ' +
      'Providers: gemini only. Models: lyria-3-clip-preview for 30-second clips, lyria-3-pro-preview for longer songs. Outputs are saved in the active workspace\'s Studio storage.',
    parameters: Type.Object({
      prompt: Type.String({ description: 'Text description of the music or sound to generate. Include genre, mood, instruments, BPM, key, structure, lyrics, and duration when relevant.' }),
      product_ids: Type.Optional(Type.Array(Type.String(), { description: 'IDs of saved products to use as visual inspiration (max 5).', maxItems: 5 })),
      persona_ids: Type.Optional(Type.Array(Type.String(), { description: 'IDs of saved personas to use as visual inspiration (max 3).', maxItems: 3 })),
      style_ids: Type.Optional(Type.Array(Type.String(), { description: 'IDs of saved visual styles to use as inspiration (max 3).', maxItems: 3 })),
      preset_id: Type.Optional(Type.String({ description: 'ID of a studio preset to use as contextual inspiration.' })),
      provider: Type.Optional(Type.String({ description: 'Provider: gemini only. Default: gemini.' })),
      model: Type.Optional(Type.String({ description: 'Model ID. Options: lyria-3-clip-preview (default, 30-second MP3 clip) or lyria-3-pro-preview (longer song, MP3 or WAV).' })),
      output_format: Type.Optional(Type.Union([Type.Literal('mp3'), Type.Literal('wav')], { description: 'Output format. MP3 is default. WAV is only supported by lyria-3-pro-preview.' })),
      source_output_id: Type.Optional(Type.String({ description: 'ID of a previous Studio image output to use as visual inspiration. Prefer this when you have the output ID.' })),
      extra_reference_urls: Type.Optional(Type.Array(Type.String(), { description: 'Up to 10 reference image file paths or URLs to use as visual inspiration for the sound. Accepts Studio/workspace paths and https image URLs.', maxItems: 10 })),
    }),
    execute: async (toolCallId, params) => {
      const p = params as Record<string, unknown>;
      if (!userId) {
        throw new Error('User ID is required for studio generation.');
      }
      const request: StudioGenerateRequest = {
        prompt: p.prompt as string,
        mode: 'sound',
        product_ids: p.product_ids as string[] | undefined,
        persona_ids: p.persona_ids as string[] | undefined,
        style_ids: p.style_ids as string[] | undefined,
        preset_id: p.preset_id as string | undefined,
        provider: 'gemini',
        model: p.model as string | undefined,
        output_format: p.output_format as StudioGenerateRequest['output_format'],
        source_output_id: p.source_output_id as string | undefined,
        extra_reference_urls: p.extra_reference_urls as string[] | undefined,
      };
      const scope = await prepareStudioToolScope(userId);
      const result = await executeFn(scope, request);
      const outputLines = result.outputs.map((o) => {
        const fullPath = requireStudioOutputAbsolutePath(o.filePath);
        return `Output:\n  File: ${fullPath}\n  URL:  ${o.mediaUrl}`;
      });
      const summary = [
        `Studio sound generation completed (${result.outputs.length} output(s))`,
        '',
        ...outputLines,
        '',
        'To copy to workspace: copy_path with sourcePath=<absolute copy source path> and destinationPath=<workspace-relative destination>.',
      ].join('\n');
      return {
        content: [{ type: 'text', text: summary }],
        details: result,
      };
    },
  };
}

export function createTranscribeAudioTool(): AgentTool {
  return {
    name: 'transcribe_audio',
    label: 'Transcribing audio',
    description:
      'Transcribes a local audio file to text using the configured voice transcription service. ' +
      'Use for voice notes, meeting recordings, Telegram audio uploads, and speech-to-text workflows. ' +
      'Accepts absolute paths such as /data/user-uploads/audio/file.ogg or workspace-relative paths.',
    parameters: Type.Object({
      file_path: Type.String({ description: 'Absolute path or workspace-relative path to an audio file.' }),
      language: Type.Optional(Type.String({ description: 'Optional ISO-639-1 language code such as de or en.' })),
      prompt: Type.Optional(Type.String({ description: 'Optional context or vocabulary hint for transcription.' })),
    }),
    execute: async (_toolCallId, params, signal) => {
      try {
        throwIfAborted(signal);
        const input = params as {
          file_path?: string;
          language?: string;
          prompt?: string;
        };
        const filePath = normalizeOptionalString(input.file_path);
        if (!filePath) {
          throw new Error('file_path is required.');
        }

        const fullPath = resolveAgentPath(filePath);
        await assertAgentPathAllowed(fullPath);
        const stats = await fsPromises.stat(fullPath);
        if (!stats.isFile()) {
          throw new Error(`Not a file: ${filePath}`);
        }
        if (stats.size > MAX_AUDIO_TRANSCRIPTION_BYTES) {
          throw new Error(`Audio file is too large for transcription. Maximum size: ${MAX_AUDIO_TRANSCRIPTION_BYTES / (1024 * 1024)}MB.`);
        }

        const buffer = await fsPromises.readFile(fullPath);
        const executionContext = getAgentExecutionContext();
        const result = await transcribeAudio({
          buffer,
          filename: path.basename(fullPath),
          mimeType: audioMimeTypeForPath(fullPath),
          language: input.language,
          prompt: input.prompt,
          signal,
          storageScope: executionContext ? { userId: executionContext.userId } : undefined,
        });

        const text = [
          `Transcript (${result.provider}/${result.model})`,
          `File: ${fullPath}`,
          '',
          result.text,
        ].join('\n');

        return {
          content: [{ type: 'text', text }],
          details: {
            filePath: fullPath,
            provider: result.provider,
            model: result.model,
            durationMs: result.durationMs,
            transcript: result.text,
          },
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

      if (!userId) {
        throw new Error('User ID is required for bulk generation.');
      }

      const job = await createFn(await prepareStudioToolScope(userId), {
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
        const products = await listFn(await prepareStudioToolScope(userId), search);
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
        const personas = await listFn(await prepareStudioToolScope(userId), search);
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
        const styles = await listFn(await prepareStudioToolScope(userId), search);
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
        const presets = await listPresets(await prepareStudioToolScope(), category);

        const text = presets.length === 0
          ? 'No studio presets found.'
          : presets.map((p) => {
              const tags = p.tags;
              const fragments = p.blocks
                .map((b) => b.promptFragment)
                .filter((f): f is string => Boolean(f));

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
