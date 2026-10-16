import 'server-only';
import sharp from 'sharp';
import type { ProviderImageInput } from './image-generation-providers';

const OPENAI_INPUT_MIME_TYPES = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const;

export async function prepareOpenAIImageInputs(references: ProviderImageInput[], mask?: ProviderImageInput) {
  if (references.length > 16) throw new Error('OpenAI supports at most 16 reference images.');
  if (mask && references.length === 0) throw new Error('An edit mask requires at least one reference image.');
  const prepared = await Promise.all(references.map(async (reference, index) => {
    const bytes = Buffer.from(reference.imageBytes, 'base64');
    if (bytes.length === 0 || bytes.length >= 50 * 1024 * 1024) {
      throw new Error(`Reference image ${index + 1} must be nonempty and smaller than 50 MB.`);
    }
    let metadata;
    try {
      metadata = await sharp(bytes).metadata();
    } catch {
      throw new Error(`Reference image ${index + 1} could not be read. Use PNG, JPEG or WebP.`);
    }
    if (!metadata.format || !(metadata.format in OPENAI_INPUT_MIME_TYPES)) {
      throw new Error(`Reference image ${index + 1} must use PNG, JPEG or WebP.`);
    }
    return { input: { ...reference, mimeType: OPENAI_INPUT_MIME_TYPES[metadata.format as keyof typeof OPENAI_INPUT_MIME_TYPES] }, metadata };
  }));
  if (mask) {
    const bytes = Buffer.from(mask.imageBytes, 'base64');
    if (bytes.length === 0 || bytes.length >= 4 * 1024 * 1024) throw new Error('An edit mask must be nonempty and smaller than 4 MB.');
    let metadata;
    try {
      metadata = await sharp(bytes).metadata();
    } catch {
      throw new Error('An edit mask must be a valid PNG image.');
    }
    if (metadata.format !== 'png' || !metadata.hasAlpha) throw new Error('An edit mask must be a PNG image with transparency.');
    const firstImage = prepared[0].metadata;
    if (metadata.width !== firstImage.width || metadata.height !== firstImage.height) {
      throw new Error('The edit mask must have the same dimensions as the first reference image.');
    }
  }
  return { referenceImages: prepared.map(({ input }) => input), editMask: mask ? { ...mask, mimeType: 'image/png' } : undefined };
}
