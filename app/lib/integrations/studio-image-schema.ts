import { Type } from 'typebox';

export const studioImageParameters = Type.Object({
  prompt: Type.String({ description: 'Text description of the image to generate.' }),
  product_ids: Type.Optional(Type.Array(Type.String(), { description: 'IDs of saved products to include as reference images (max 5).', maxItems: 5 })),
  persona_ids: Type.Optional(Type.Array(Type.String(), { description: 'IDs of saved personas to include as reference images (max 3).', maxItems: 3 })),
  style_ids: Type.Optional(Type.Array(Type.String(), { description: 'IDs of saved styles to apply as reference images (max 3).', maxItems: 3 })),
  preset_id: Type.Optional(Type.String({ description: 'ID of a studio preset to apply (lighting, camera, background settings).' })),
  aspect_ratio: Type.Optional(Type.String({ description: 'Aspect ratio metadata. Gemini supports 1:1 (default), 16:9, 9:16, 4:3 and 3:4. OpenAI also supports 3:2, 2:3, 4:5 and auto. For OpenAI custom sizes, image_size is authoritative and the exact ratio is derived from it.' })),
  count: Type.Optional(Type.Integer({ description: 'Number of image variations. Gemini supports 1-4; OpenAI supports 1-10. Default: 1.', minimum: 1, maximum: 10 })),
  provider: Type.Optional(Type.String({ description: 'Provider: gemini or openai. Default: gemini.' })),
  model: Type.Optional(Type.String({ description: 'Model ID. Options: gemini-3.1-flash-image (default, best quality & features), gemini-3-pro-image (pro quality & reasoning, Nano Banana Pro), gpt-image-2.5-sunburst (best quality when provider is openai), gpt-image-2.5-flare (fast generation when provider is openai). If omitted, defaults to the best model for the selected provider.' })),
  image_size: Type.Optional(Type.String({ description: 'Image resolution. Gemini: "512" (only gemini-3.1-flash), "1K", "2K", or "4K". OpenAI: "auto" or WIDTHxHEIGHT. Useful presets are 1024x1024, 1536x1024, 1024x1536, 1536x864, 864x1536, 1344x1008, 1008x1344, and 1024x1280. Custom OpenAI edges must be multiples of 16, at most 3840px, ratio at most 3:1, and total pixels between 655,360 and 8,294,400.' })),
  quality: Type.Optional(Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high'), Type.Literal('xhigh'), Type.Literal('max'), Type.Literal('auto')], { description: 'Image quality. OpenAI only. Default: auto.' })),
  output_format: Type.Optional(Type.Union([Type.Literal('png'), Type.Literal('jpeg'), Type.Literal('webp')], { description: 'Output format. OpenAI only. Default: png. For a transparent background, use png (recommended) or webp; jpeg does not support transparency.' })),
  background: Type.Optional(Type.Union([Type.Literal('transparent'), Type.Literal('opaque'), Type.Literal('auto')], { description: 'Background treatment. OpenAI only. Default: auto. To request a transparent image, set this to transparent and set output_format to png (recommended) or webp.' })),
  moderation: Type.Optional(Type.Union([Type.Literal('auto'), Type.Literal('low')], { description: 'Content moderation level. OpenAI only. Default: auto.' })),
  output_compression: Type.Optional(Type.Integer({ description: 'JPEG/WebP compression from 0 to 100. OpenAI only. Default: 100; ignored for PNG.', minimum: 0, maximum: 100 })),
  stream: Type.Optional(Type.Boolean({ description: 'Use the OpenAI image streaming transport and keep the final completed image. Default: false.' })),
  partial_images: Type.Optional(Type.Integer({ description: 'Number of streamed partial images (0-3). Requires stream=true. Partial images incur additional image tokens; Studio persists only the final completed image.', minimum: 0, maximum: 3 })),
  source_output_id: Type.Optional(Type.String({ description: 'ID of a previous Studio output to use as the base image for editing or variation. Prefer this when you have the output ID.' })),
  extra_reference_urls: Type.Optional(Type.Array(Type.String(), { description: 'Reference image file paths or URLs to load as visual input for editing, variations, style matching, or image-to-image generation. Put every local reference image path here; do not only write paths in the prompt. Accepts exact workspace-scoped Studio paths returned by Studio tools, /api/studio/media/... and /api/studio/references/... URLs, products/image.png, personas/image.png, styles/image.png, workspace paths like 09_asset-library/photo.png or /api/media/09_asset-library/photo.png, plus https image URLs.' })),
});
