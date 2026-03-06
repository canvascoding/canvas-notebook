import { type AgentEvent } from '@mariozechner/pi-agent-core';

/**
 * Encodes AgentEvent into a string for streaming.
 */
export function encodeAgentEvent(event: AgentEvent): string {
  return JSON.stringify(event) + '\n';
}

/**
 * Maps various errors to a unified PI error event.
 */
export function mapPiError(error: any): AgentEvent {
  const message = error.message || 'Unknown agent error';
  
  // Detect provider errors
  if (message.includes('API key') || message.includes('Unauthorized')) {
    return { type: 'error', error: `Authentication failed: ${message}` } as any;
  }
  
  if (message.includes('model not found') || message.includes('invalid model')) {
    return { type: 'error', error: `Model error: ${message}` } as any;
  }

  // Tool errors are usually already wrapped in AgentEvent by the loop,
  // but if the loop itself fails, we wrap it here.
  return { type: 'error', error: message } as any;
}

/**
 * Creates a ReadableStream from an Agent event stream.
 */
export function createAgentResponseStream(agentEventStream: any): ReadableStream {
  const encoder = new TextEncoder();
  
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const event of agentEventStream) {
          controller.enqueue(encoder.encode(encodeAgentEvent(event)));
        }
      } catch (error: any) {
        controller.enqueue(encoder.encode(encodeAgentEvent(mapPiError(error))));
      } finally {
        controller.close();
      }
    },
  });
}
