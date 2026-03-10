/**
 * Thinking Filter - Extracts <thinking> blocks from text streams
 *
 * Handles Ollama models that output reasoning/thinking content wrapped in tags.
 * Supports streaming where tags may span across chunk boundaries.
 */

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

const THINKING_START_REGEX = /<thinking>/i;
const THINKING_END_REGEX = /<\/thinking>/i;
const REASONING_START_REGEX = /<reasoning>/i;
const REASONING_END_REGEX = /<\/reasoning>/i;

/**
 * Initialize a new filter state
 */
export function createThinkingFilterState(): ThinkingFilterState {
  return {
    buffer: '',
    inThinkingBlock: false,
    thinkingContent: '',
  };
}

/**
 * Process a text chunk and extract any thinking content.
 * Handles partial tags that span across chunk boundaries.
 */
export function filterThinkingChunk(
  chunk: string,
  state: ThinkingFilterState
): FilterResult {
  // Append new chunk to buffer
  const combined = state.buffer + chunk;
  let remaining = combined;
  let outputText = '';
  let outputThinking: string | undefined;

  const newState: ThinkingFilterState = {
    buffer: '',
    inThinkingBlock: state.inThinkingBlock,
    thinkingContent: state.thinkingContent,
  };

  while (remaining.length > 0) {
    if (!newState.inThinkingBlock) {
      // Looking for opening tag
      const startMatchThinking = remaining.match(THINKING_START_REGEX);
      const startMatchReasoning = remaining.match(REASONING_START_REGEX);

      let startMatch: RegExpMatchArray | null = null;
      let startIndex = -1;
      let tagLength = 0;

      if (startMatchThinking && startMatchReasoning) {
        // Both found, use the one that comes first
        if (startMatchThinking.index! <= startMatchReasoning.index!) {
          startMatch = startMatchThinking;
          startIndex = startMatchThinking.index!;
          tagLength = '<thinking>'.length;
        } else {
          startMatch = startMatchReasoning;
          startIndex = startMatchReasoning.index!;
          tagLength = '<reasoning>'.length;
        }
      } else if (startMatchThinking) {
        startMatch = startMatchThinking;
        startIndex = startMatchThinking.index!;
        tagLength = '<thinking>'.length;
      } else if (startMatchReasoning) {
        startMatch = startMatchReasoning;
        startIndex = startMatchReasoning.index!;
        tagLength = '<reasoning>'.length;
      }

      if (startMatch && startIndex !== -1) {
        // Found opening tag - output text before it
        outputText += remaining.slice(0, startIndex);

        // Check if we have a complete closing tag
        const endMatchThinking = remaining.slice(startIndex + tagLength).match(THINKING_END_REGEX);
        const endMatchReasoning = remaining.slice(startIndex + tagLength).match(REASONING_END_REGEX);

        let endMatch: RegExpMatchArray | null = null;
        let endIndex = -1;
        let endTagLength = 0;

        if (endMatchThinking && endMatchReasoning) {
          if (endMatchThinking.index! <= endMatchReasoning.index!) {
            endMatch = endMatchThinking;
            endIndex = endMatchThinking.index!;
            endTagLength = '</thinking>'.length;
          } else {
            endMatch = endMatchReasoning;
            endIndex = endMatchReasoning.index!;
            endTagLength = '</reasoning>'.length;
          }
        } else if (endMatchThinking) {
          endMatch = endMatchThinking;
          endIndex = endMatchThinking.index!;
          endTagLength = '</thinking>'.length;
        } else if (endMatchReasoning) {
          endMatch = endMatchReasoning;
          endIndex = endMatchReasoning.index!;
          endTagLength = '</reasoning>'.length;
        }

        if (endMatch && endIndex !== -1) {
          // Complete thinking block found
          const thinkingStart = startIndex + tagLength;
          const thinkingContent = remaining.slice(thinkingStart, startIndex + tagLength + endIndex);
          outputThinking = outputThinking ? outputThinking + thinkingContent : thinkingContent;
          remaining = remaining.slice(startIndex + tagLength + endIndex + endTagLength);
        } else {
          // Incomplete - entering thinking block
          newState.inThinkingBlock = true;
          newState.thinkingContent = remaining.slice(startIndex + tagLength);
          remaining = '';
        }
      } else {
        // No opening tag found
        // Keep last 20 chars in buffer in case a tag is split across chunks
        if (remaining.length > 20) {
          outputText += remaining.slice(0, -20);
          newState.buffer = remaining.slice(-20);
        } else {
          newState.buffer = remaining;
        }
        remaining = '';
      }
    } else {
      // Currently in thinking block - looking for closing tag
      const endMatchThinking = remaining.match(THINKING_END_REGEX);
      const endMatchReasoning = remaining.match(REASONING_END_REGEX);

      let endMatch: RegExpMatchArray | null = null;
      let endIndex = -1;
      let endTagLength = 0;

      if (endMatchThinking && endMatchReasoning) {
        if (endMatchThinking.index! <= endMatchReasoning.index!) {
          endMatch = endMatchThinking;
          endIndex = endMatchThinking.index!;
          endTagLength = '</thinking>'.length;
        } else {
          endMatch = endMatchReasoning;
          endIndex = endMatchReasoning.index!;
          endTagLength = '</reasoning>'.length;
        }
      } else if (endMatchThinking) {
        endMatch = endMatchThinking;
        endIndex = endMatchThinking.index!;
        endTagLength = '</thinking>'.length;
      } else if (endMatchReasoning) {
        endMatch = endMatchReasoning;
        endIndex = endMatchReasoning.index!;
        endTagLength = '</reasoning>'.length;
      }

      if (endMatch && endIndex !== -1) {
        // Found closing tag - complete the thinking block
        const thinkingContent = newState.thinkingContent + remaining.slice(0, endIndex);
        outputThinking = outputThinking ? outputThinking + thinkingContent : thinkingContent;
        newState.inThinkingBlock = false;
        newState.thinkingContent = '';
        remaining = remaining.slice(endIndex + endTagLength);
      } else {
        // Still in thinking block - accumulate content
        newState.thinkingContent += remaining;
        // Keep last 20 chars as buffer in case closing tag is split
        if (newState.thinkingContent.length > 20) {
          const excess = newState.thinkingContent.slice(0, -20);
          outputThinking = outputThinking ? outputThinking + excess : excess;
          newState.thinkingContent = newState.thinkingContent.slice(-20);
        }
        remaining = '';
      }
    }
  }

  return {
    text: outputText,
    thinking: outputThinking,
    state: newState,
  };
}

/**
 * Flush any remaining content when stream ends
 */
export function flushThinkingFilter(state: ThinkingFilterState): FilterResult {
  // If we were in a thinking block, treat remaining content as thinking
  const thinking = state.inThinkingBlock
    ? (state.thinkingContent || '') + state.buffer
    : state.buffer;

  return {
    text: '',
    thinking: thinking || undefined,
    state: createThinkingFilterState(),
  };
}
