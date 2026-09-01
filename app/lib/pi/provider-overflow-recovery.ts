import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  isContextOverflow,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';

export type PiProviderOverflowRecoveryInput = Readonly<{
  model: Model<Api>;
  context: Context;
  options: SimpleStreamOptions | undefined;
  overflowMessage: AssistantMessage;
}>;

export type PiProviderOverflowRecovery = (
  input: PiProviderOverflowRecoveryInput,
) => Promise<Context | null>;

function exposesPartialOutput(event: AssistantMessageEvent): boolean {
  return event.type !== 'start'
    && event.type !== 'done'
    && event.type !== 'error';
}

function terminalEvent(message: AssistantMessage): AssistantMessageEvent {
  return message.stopReason === 'error' || message.stopReason === 'aborted'
    ? { type: 'error', reason: message.stopReason, error: message }
    : {
        type: 'done',
        reason: message.stopReason === 'pending' ? 'stop' : message.stopReason,
        message,
      };
}

function failureMessage(model: Model<Api>, error: unknown): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: '' }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

function isProviderContextOverflow(message: AssistantMessage, contextWindow: number): boolean {
  return isContextOverflow(message, contextWindow)
    || (
      message.stopReason === 'error'
      && /final serialized request exceeds the selected model context window/iu.test(message.errorMessage ?? '')
    );
}

/**
 * Retries one provider-detected context overflow only while no partial output
 * has escaped. All first-attempt events stay buffered until that decision is
 * known, preventing duplicate text or tool calls.
 */
export function withPiProviderOverflowRecovery(
  streamFn: StreamFn,
  recover: PiProviderOverflowRecovery,
): StreamFn {
  return (model, initialContext, options) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      let context = initialContext;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const buffered: AssistantMessageEvent[] = [];
        let exposed = false;
        let finalMessage: AssistantMessage | null = null;
        try {
          const source = await streamFn(model, context, options);
          for await (const event of source) {
            if (!exposed) {
              buffered.push(event);
              if (exposesPartialOutput(event)) {
                exposed = true;
                for (const bufferedEvent of buffered) output.push(bufferedEvent);
                buffered.length = 0;
              }
            } else {
              output.push(event);
            }
            if (event.type === 'done') finalMessage = event.message;
            if (event.type === 'error') finalMessage = event.error;
          }
          finalMessage ??= await source.result();
        } catch (error) {
          finalMessage = failureMessage(model, error);
          if (exposed) output.push(terminalEvent(finalMessage));
        }
        if (exposed) return;
        const overflow = isProviderContextOverflow(finalMessage, model.contextWindow);
        if (overflow && attempt === 0) {
          let recovered: Context | null = null;
          try {
            recovered = await recover({
              model,
              context,
              options,
              overflowMessage: finalMessage,
            });
          } catch {
            recovered = null;
          }
          if (recovered) {
            context = recovered;
            continue;
          }
        }
        if (buffered.length === 0) buffered.push(terminalEvent(finalMessage));
        for (const event of buffered) output.push(event);
        return;
      }
    })().catch((error) => {
      output.push({ type: 'error', reason: 'error', error: failureMessage(model, error) });
    });
    return output;
  };
}
