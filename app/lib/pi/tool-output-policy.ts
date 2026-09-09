/**
 * Stable limits for persisted provider and tool output.  Keep these values
 * independent from a provider's own request limits: the store is the final
 * safeguard for data that is offered for later, session-scoped reading.
 */
export const TOOL_OUTPUT_POLICY_VERSION = 'tool-output-v1';

export const MAX_TOOL_OUTPUT_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_TOOL_OUTPUT_SESSION_BYTES = 64 * 1024 * 1024;

export const TOOL_OUTPUT_SEARCH_DEFAULT_RESULTS = 5;
export const TOOL_OUTPUT_SEARCH_MAX_SNIPPET_CHARACTERS = 800;
export const TOOL_OUTPUT_SEARCH_MAX_CHARACTERS = 6_000;
export const TOOL_OUTPUT_PAGE_MAX_CHARACTERS_PER_PAGE = 6_000;
export const TOOL_OUTPUT_PAGE_MAX_CHARACTERS = 10_000;
export const TOOL_OUTPUT_LARGE_RESULT_MAX_CHARACTERS = 12_000;
export const TOOL_OUTPUT_LARGE_RESULT_PREVIEW_CHARACTERS = 1_500;
export const TOOL_OUTPUT_READ_DEFAULT_CHARACTERS = 6_000;
export const TOOL_OUTPUT_READ_MAX_CHARACTERS = 10_000;
export const TOOL_OUTPUT_SMALL_MODEL_MAX_CONTEXT_FRACTION = 0.05;
export const TOOL_OUTPUT_BLOCK_MAX_TOKENS = 6_000;
export const TOOL_OUTPUT_BLOCK_MAX_CONTEXT_FRACTION = 0.15;
