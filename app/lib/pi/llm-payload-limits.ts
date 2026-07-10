// These limits are deliberately byte-based. Model context windows measure tokens,
// but inline images are base64-encoded and can otherwise overflow an HTTP proxy.
export const MAX_LLM_IMAGE_BYTES = 750 * 1024;
export const MAX_LLM_TOTAL_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_LLM_HISTORY_BYTES = 8 * 1024 * 1024;
