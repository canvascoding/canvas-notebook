import type { AfterToolCallContext, AfterToolCallResult } from '@earendil-works/pi-agent-core';

const DEFAULT_WARNING_THRESHOLD = 2;
const DEFAULT_TERMINATION_THRESHOLD = 4;

type ToolLoopGuardOptions = {
  warningThreshold?: number;
  terminationThreshold?: number;
};

type ToolLoopGuardDetails = {
  toolLoopGuard: {
    repeatedToolFailure: true;
    count: number;
    terminated: boolean;
    toolName: string;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(value, (_key, nestedValue) => {
    if (!isRecord(nestedValue)) {
      return nestedValue;
    }

    if (seen.has(nestedValue)) {
      return '[Circular]';
    }
    seen.add(nestedValue);

    return Object.keys(nestedValue)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = nestedValue[key];
        return acc;
      }, {});
  });

  return serialized ?? String(value);
}

function normalizeToolErrorText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function getToolResultText(context: AfterToolCallContext): string {
  return context.result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
    .trim();
}

function getToolResultErrorText(context: AfterToolCallContext): string {
  const text = getToolResultText(context);
  if (text) return text;

  if (isRecord(context.result.details) && typeof context.result.details.error === 'string') {
    return context.result.details.error;
  }

  return '';
}

function isErrorLikeToolResult(context: AfterToolCallContext): boolean {
  if (context.isError) return true;
  if (isRecord(context.result.details) && context.result.details.error) return true;

  const text = getToolResultText(context);
  return /^Error:/i.test(text) || /Command failed:/i.test(text);
}

function createFailureSignature(context: AfterToolCallContext): string {
  const errorText = normalizeToolErrorText(getToolResultErrorText(context));
  return [
    context.toolCall.name,
    stableStringify(context.args),
    errorText,
  ].join('\n');
}

function createDetails(
  originalDetails: unknown,
  count: number,
  terminated: boolean,
  toolName: string,
): unknown {
  const loopGuardDetails: ToolLoopGuardDetails = {
    toolLoopGuard: {
      repeatedToolFailure: true,
      count,
      terminated,
      toolName,
    },
  };

  if (isRecord(originalDetails)) {
    return {
      ...originalDetails,
      ...loopGuardDetails,
    };
  }

  return {
    originalDetails,
    ...loopGuardDetails,
  };
}

function createRepeatedFailureMessage(
  originalErrorText: string,
  count: number,
  terminated: boolean,
): string {
  const guidance = terminated
    ? 'The agent run was stopped to avoid an infinite tool loop.'
    : 'Do not retry this exact same tool call again. Use a different approach, inspect the error, or ask the user for help if this is blocked.';

  return [
    `Error: The same tool call failed ${count} times in a row.`,
    guidance,
    '',
    'Last tool error:',
    originalErrorText || '(no error text)',
  ].join('\n');
}

export function createToolLoopGuard(options: ToolLoopGuardOptions = {}) {
  const warningThreshold = Math.max(2, Math.trunc(options.warningThreshold ?? DEFAULT_WARNING_THRESHOLD));
  const terminationThreshold = Math.max(
    warningThreshold,
    Math.trunc(options.terminationThreshold ?? DEFAULT_TERMINATION_THRESHOLD),
  );

  let lastFailureSignature: string | null = null;
  let repeatedFailureCount = 0;

  return {
    reset() {
      lastFailureSignature = null;
      repeatedFailureCount = 0;
    },

    afterToolCall(context: AfterToolCallContext): AfterToolCallResult | undefined {
      if (!isErrorLikeToolResult(context)) {
        lastFailureSignature = null;
        repeatedFailureCount = 0;
        return undefined;
      }

      const signature = createFailureSignature(context);
      repeatedFailureCount = signature === lastFailureSignature ? repeatedFailureCount + 1 : 1;
      lastFailureSignature = signature;

      if (repeatedFailureCount < warningThreshold) {
        return undefined;
      }

      const terminated = repeatedFailureCount >= terminationThreshold;
      const errorText = getToolResultErrorText(context);

      return {
        content: [{
          type: 'text',
          text: createRepeatedFailureMessage(errorText, repeatedFailureCount, terminated),
        }],
        details: createDetails(context.result.details, repeatedFailureCount, terminated, context.toolCall.name),
        isError: true,
        terminate: terminated,
      };
    },
  };
}
