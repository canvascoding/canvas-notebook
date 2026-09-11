// Shared by prose, table serialization and the server-side Markdown tokenizer.
export const EXPLICIT_TABLE_HARD_BREAK = '<br data-canvas-hard-break>';
export const EXPLICIT_TABLE_HARD_BREAK_PATTERN = /^<br\s+data-canvas-hard-break\s*\/?>/iu;
export const EXPLICIT_TABLE_HARD_BREAK_START = /<br\s+data-canvas-hard-break\b/iu;
