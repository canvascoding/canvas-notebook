const IMAGE_INPUT_UNSUPPORTED_PATTERNS = [
  /image inputs? (?:are|is) not supported/i,
  /images? (?:are|is) not supported (?:by|for) (?:this )?model/i,
  /(?:this|the current) model does not support images?/i,
  /model does not support images?/i,
  /unsupported (?:input )?modality[^.:\n]*image/i,
  /invalid request content[\s\S]{0,240}image/i,
  /image_url[\s\S]{0,240}(?:not supported|unsupported)/i,
];

export function isImageInputUnsupportedError(message: string): boolean {
  return IMAGE_INPUT_UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(message));
}

export function formatImageInputUnsupportedError(params: { modelId: string; provider: string; message: string }): string {
  return [
    `The selected model (${params.provider}/${params.modelId}) rejected the attached image input.`,
    'Canvas did not crash; the provider refused the multimodal request after the image was sent.',
    'Choose a model that supports image input, or switch this model/provider to text-only behavior before using image attachments.',
    '',
    `Provider error: ${params.message}`,
  ].join('\n');
}
