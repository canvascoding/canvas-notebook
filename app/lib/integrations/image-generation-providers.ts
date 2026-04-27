import 'server-only';

import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import { getGeminiApiKeyFromIntegrations, getOpenAIApiKeyFromIntegrations } from './env-config';

export interface ImageModelOption {
  id: string;
  label: string;
  shortLabel: string;
  description: string;
}

export interface ImageGenerationProvider {
  id: string;
  name: string;
  requiredApiKey: string;
  models: ImageModelOption[];
  supportedAspectRatios: string[];
  maxReferenceImages: number;
  maxImageCount: number;
  supportsQuality: boolean;
  supportsOutputFormat: boolean;
  supportsBackground: boolean;
  getMaxReferenceImages(model: string): number;
  generate(params: ProviderGenerateParams): Promise<ProviderGenerateResult>;
}

export interface ProviderGenerateParams {
  prompt: string;
  model: string;
  aspectRatio: string;
  referenceImages: Array<{ imageBytes: string; mimeType: string }>;
  quality?: 'low' | 'medium' | 'high' | 'auto';
  outputFormat?: 'png' | 'jpeg' | 'webp';
  background?: 'transparent' | 'opaque' | 'auto';
  contextPrompt?: string;
}

export interface ProviderGenerateResult {
  imageBytes: string;
  mimeType: string;
  usage?: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
  };
}

const GEMINI_MODELS: ImageModelOption[] = [
  {
    id: 'gemini-3.1-flash-image-preview',
    label: '🎨 Best Quality & Features',
    shortLabel: 'Gemini 3.1 Flash Image',
    description: 'Latest model with the highest quality and more capabilities. Supports up to 14 reference images and advanced features like grounding. Best for professional results.',
  },
  {
    id: 'gemini-2.5-flash-image',
    label: '⚡ Fast & Affordable',
    shortLabel: 'Gemini 2.5 Flash Image',
    description: 'Faster generation at lower cost. Supports up to 3 reference images. Great for quick drafts, simple visuals, and faster iteration.',
  },
];

const OPENAI_MODELS: ImageModelOption[] = [
  {
    id: 'gpt-image-2',
    label: '🎨 Best Quality',
    shortLabel: 'GPT Image 2',
    description: 'Latest state-of-the-art model with superior instruction following, text rendering and editing.',
  },
  {
    id: 'gpt-image-1.5',
    label: '🎨 Best Quality',
    shortLabel: 'GPT Image 1.5',
    description: 'State of the art model with superior instruction following, text rendering and editing.',
  },
  {
    id: 'gpt-image-1',
    label: '✨ High Quality',
    shortLabel: 'GPT Image 1',
    description: 'High quality generation with detailed editing capabilities.',
  },
  {
    id: 'gpt-image-1-mini',
    label: '⚡ Fast & Affordable',
    shortLabel: 'GPT Image 1 Mini',
    description: 'Cost-effective option for fast iterations where top quality isn\'t critical.',
  },
];

const GEMINI_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4'];
const OPENAI_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', 'auto'];

type OpenAIImageSize = '1024x1024' | '1536x1024' | '1024x1536' | 'auto';

const OPENAI_SIZE_MAP: Record<string, OpenAIImageSize> = {
  '1:1': '1024x1024',
  '16:9': '1536x1024',
  '9:16': '1024x1536',
  '4:3': '1536x1024',
  '3:4': '1024x1536',
  'auto': 'auto',
};

function extractUsage(usage: unknown): ProviderGenerateResult['usage'] {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as unknown as Record<string, unknown>;
  const totalTokens = typeof u.total_tokens === 'number' ? u.total_tokens : undefined;
  const inputTokens = typeof u.input_tokens === 'number' ? u.input_tokens : undefined;
  const outputTokens = typeof u.output_tokens === 'number' ? u.output_tokens : undefined;
  if (totalTokens === undefined && inputTokens === undefined && outputTokens === undefined) return undefined;
  return { totalTokens: totalTokens ?? 0, inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };
}

function extractInlineImage(response: unknown): { imageBytes: string; mimeType: string } {
  const candidates = (
    response as {
      candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string }; text?: string }> } }>;
    }
  ).candidates;

  for (const candidate of candidates || []) {
    for (const part of candidate.content?.parts || []) {
      if (part.inlineData?.data) {
        return {
          imageBytes: part.inlineData.data,
          mimeType: part.inlineData.mimeType || 'image/png',
        };
      }
    }
  }

  const fallback = response as { data?: string };
  if (fallback.data) {
    return { imageBytes: fallback.data, mimeType: 'image/png' };
  }

  console.error(`[Gemini Image] No image in response. Response structure:`, JSON.stringify(response, null, 2).slice(0, 2000));
  throw new Error('No image was returned by the model');
}

class GeminiImageProvider implements ImageGenerationProvider {
  id = 'gemini';
  name = 'Google Gemini';
  requiredApiKey = 'GEMINI_API_KEY';
  models = GEMINI_MODELS;
  supportedAspectRatios = GEMINI_ASPECT_RATIOS;
  maxReferenceImages = 10;
  maxImageCount = 4;
  supportsQuality = false;
  supportsOutputFormat = false;
  supportsBackground = false;

  getMaxReferenceImages(model: string): number {
    if (model === 'gemini-3.1-flash-image-preview') {
      return 14;
    }
    if (model === 'gemini-2.5-flash-image') {
      return 3;
    }
    return this.maxReferenceImages;
  }

  async generate(params: ProviderGenerateParams): Promise<ProviderGenerateResult> {
    const apiKey = await getGeminiApiKeyFromIntegrations();
    if (!apiKey) {
      throw new Error('Gemini API key is missing. Configure GEMINI_API_KEY in /settings.');
    }

    console.log(`[Gemini Image] Generating: model=${params.model}, aspectRatio=${params.aspectRatio}, refs=${params.referenceImages.length}, contextPrompt=${params.contextPrompt ? 'yes' : 'no'}, prompt="${params.prompt.slice(0, 80)}..."`);

    const ai = new GoogleGenAI({ apiKey });

    const parts: Array<{ inlineData: { data: string; mimeType: string } } | { text: string }> = [];

    // Inject context prompt as first text part if available
    if (params.contextPrompt) {
      parts.push({ text: params.contextPrompt });
    }

    for (const image of params.referenceImages) {
      parts.push({
        inlineData: {
          data: image.imageBytes,
          mimeType: image.mimeType,
        },
      });
    }

    if (params.prompt) {
      parts.push({ text: params.prompt });
    }

    const response = await ai.models.generateContent({
      model: params.model,
      contents: [
        {
          role: 'user',
          parts,
        },
      ],
      config: {
        responseModalities: ['IMAGE', 'TEXT'],
        imageConfig: {
          aspectRatio: params.aspectRatio,
          imageSize: '1K',
        },
      },
    });

    console.log(`[Gemini Image] Response received: candidates=${(response as { candidates?: unknown[] })?.candidates?.length ?? 'N/A'}, hasInlineData=${JSON.stringify((response as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: unknown }> } }> })?.candidates?.[0]?.content?.parts?.map(p => !!p.inlineData) ?? 'unknown')}`);

    const generated = extractInlineImage(response);
    return {
      imageBytes: generated.imageBytes,
      mimeType: generated.mimeType,
    };
  }
}

class OpenAIImageProvider implements ImageGenerationProvider {
  id = 'openai';
  name = 'OpenAI GPT Image';
  requiredApiKey = 'OPENAI_API_KEY';
  models = OPENAI_MODELS;
  supportedAspectRatios = OPENAI_ASPECT_RATIOS;
  maxReferenceImages = 16;
  maxImageCount = 10;
  supportsQuality = true;
  supportsOutputFormat = true;
  supportsBackground = true;

  getMaxReferenceImages(): number {
    return this.maxReferenceImages;
  }

  async generate(params: ProviderGenerateParams): Promise<ProviderGenerateResult> {
    const apiKey = await getOpenAIApiKeyFromIntegrations();
    if (!apiKey) {
      throw new Error('OpenAI API key is missing. Configure OPENAI_API_KEY in /settings.');
    }

    console.log(`[OpenAI Image] Generating: model=${params.model}, aspectRatio=${params.aspectRatio}, refs=${params.referenceImages.length}, quality=${params.quality || 'auto'}`);

    const openai = new OpenAI({ apiKey });
    const size = OPENAI_SIZE_MAP[params.aspectRatio] || '1024x1024';

    const hasReferences = params.referenceImages.length > 0;
    // Combine context prompt and user prompt for OpenAI
    const fullPrompt = params.contextPrompt
      ? `${params.contextPrompt}\n\n${params.prompt || 'Edit this image'}`
      : (params.prompt || 'Edit this image');

    if (hasReferences) {
      const imageBuffers = params.referenceImages.map((img) => {
        const buffer = Buffer.from(img.imageBytes, 'base64');
        return new File([buffer], `image.${img.mimeType.split('/')[1] || 'png'}`, { type: img.mimeType });
      });

      const result = await openai.images.edit({
        model: params.model,
        prompt: fullPrompt,
        image: imageBuffers.length === 1 ? imageBuffers[0] : imageBuffers,
        size,
        quality: params.quality || 'auto',
        output_format: params.outputFormat || 'png',
        background: params.background || 'auto',
        n: 1,
      });

      const image = result.data?.[0];
      if (!image?.b64_json) {
        throw new Error('No image was returned by OpenAI');
      }

      return {
        imageBytes: image.b64_json,
        mimeType: `image/${params.outputFormat || 'png'}`,
        usage: extractUsage(result.usage),
      };
    }

    const result = await openai.images.generate({
      model: params.model,
      prompt: fullPrompt,
      n: 1,
      size,
      quality: params.quality || 'auto',
      output_format: params.outputFormat || 'png',
      background: params.background || 'auto',
    });

    const image = result.data?.[0];
    if (!image?.b64_json) {
      throw new Error('No image was returned by OpenAI');
    }

    return {
      imageBytes: image.b64_json,
      mimeType: `image/${params.outputFormat || 'png'}`,
      usage: extractUsage(result.usage),
    };
  }
}

const PROVIDER_REGISTRY: Record<string, ImageGenerationProvider> = {
  gemini: new GeminiImageProvider(),
  openai: new OpenAIImageProvider(),
};

export function getImageGenerationProvider(providerId: string): ImageGenerationProvider | null {
  return PROVIDER_REGISTRY[providerId] || null;
}

export function getAllProviders(): ImageGenerationProvider[] {
  return Object.values(PROVIDER_REGISTRY);
}

export function getProviderModels(providerId: string): ImageModelOption[] {
  const provider = PROVIDER_REGISTRY[providerId];
  return provider ? provider.models : [];
}
