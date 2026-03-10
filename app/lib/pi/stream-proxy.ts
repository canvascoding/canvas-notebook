import { type AgentEvent } from '@mariozechner/pi-agent-core';

type AgentErrorEvent = {
  type: 'error';
  error: string;
};

type StreamAgentEvent = AgentEvent | AgentErrorEvent;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown agent error';
}

/**
 * Encodes AgentEvent into a string for streaming.
 */
export function encodeAgentEvent(event: StreamAgentEvent): string {
  return JSON.stringify(event) + '\n';
}

/**
 * Maps various errors to a unified PI error event.
 */
export function mapPiError(error: unknown): AgentErrorEvent {
  const message = getErrorMessage(error);

  // Detect provider errors
  if (message.includes('API key') || message.includes('Unauthorized')) {
    return { type: 'error', error: `Authentication failed: ${message}` };
  }

  if (message.includes('model not found') || message.includes('invalid model')) {
    return { type: 'error', error: `Model error: ${message}` };
  }

  // Tool errors are usually already wrapped in AgentEvent by the loop,
  // but if the loop itself fails, we wrap it here.
  return { type: 'error', error: message };
}

/**
 * Creates a ReadableStream from an Agent event stream.
 */
export function createAgentResponseStream(agentEventStream: AsyncIterable<AgentEvent>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      try {
        for await (const event of agentEventStream) {
          controller.enqueue(encoder.encode(encodeAgentEvent(event)));
        }
      } catch (error: unknown) {
        controller.enqueue(encoder.encode(encodeAgentEvent(mapPiError(error))));
      } finally {
        controller.close();
      }
    },
  });
}
