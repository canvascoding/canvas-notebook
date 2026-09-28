/** Extract reasoning markup from model text, including tags split across chunks. */

export type ThinkingFilterState = {
  buffer: string;
  inThinkingBlock: boolean;
  thinkingContent: string;
};

export type FilterResult = {
  text: string;
  thinking?: string;
  state: ThinkingFilterState;
};

const THINKING_TAGS = [
  '<think>', '</think>',
  '<thinking>', '</thinking>',
  '<reasoning>', '</reasoning>',
] as const;
const THINKING_TAG_REGEX = /<\/?(?:think|thinking|reasoning)>/gi;
const MAX_TAG_LENGTH = Math.max(...THINKING_TAGS.map((tag) => tag.length));

function trailingTagPrefixLength(value: string): number {
  const maxLength = Math.min(value.length, MAX_TAG_LENGTH - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    const suffix = value.slice(-length).toLowerCase();
    if (THINKING_TAGS.some((tag) => tag.startsWith(suffix))) {
      return length;
    }
  }
  return 0;
}

export function createThinkingFilterState(): ThinkingFilterState {
  return { buffer: '', inThinkingBlock: false, thinkingContent: '' };
}

export function filterThinkingChunk(chunk: string, state: ThinkingFilterState): FilterResult {
  const input = state.buffer + chunk;
  let text = '';
  let thinking = '';
  let cursor = 0;
  let inThinkingBlock = state.inThinkingBlock;

  // A closing tag without an opening tag can occur when a provider already
  // separated the reasoning content. Consume that marker as well.
  for (const match of input.matchAll(THINKING_TAG_REGEX)) {
    const index = match.index ?? 0;
    const content = input.slice(cursor, index);
    if (inThinkingBlock) thinking += content;
    else text += content;
    inThinkingBlock = !match[0].startsWith('</');
    cursor = index + match[0].length;
  }

  const remainder = input.slice(cursor);
  const prefixLength = trailingTagPrefixLength(remainder);
  const content = remainder.slice(0, remainder.length - prefixLength);
  if (inThinkingBlock) thinking += content;
  else text += content;

  return {
    text,
    thinking: thinking || undefined,
    state: {
      buffer: prefixLength ? remainder.slice(-prefixLength) : '',
      inThinkingBlock,
      thinkingContent: '',
    },
  };
}

export function flushThinkingFilter(state: ThinkingFilterState): FilterResult {
  return {
    text: state.inThinkingBlock ? '' : state.buffer,
    thinking: state.inThinkingBlock ? state.buffer || undefined : undefined,
    state: createThinkingFilterState(),
  };
}

/** Apply the same rules to completed messages and stored chat history. */
export function stripThinkingMarkup(text: string): string {
  const filtered = filterThinkingChunk(text, createThinkingFilterState());
  const flushed = flushThinkingFilter(filtered.state);
  return (filtered.text + flushed.text).trim();
}
