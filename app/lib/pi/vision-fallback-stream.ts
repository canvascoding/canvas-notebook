import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';

import { isImageInputUnsupportedError } from './vision-input-rejection';

type ImagePart = { type: 'image' };
type MessageWithContent = Message & { content: unknown[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isImagePart(value: unknown): value is ImagePart {
  return isRecord(value) && value.type === 'image';
}

function isMessageWithContent(message: Message): message is MessageWithContent {
  return isRecord(message) && Array.isArray(message.content);
}

function contextContainsImages(context: Context): boolean {
  return context.messages.some((message) => (
    isMessageWithContent(message) && message.content.some(isImagePart)
  ));
}

function modelWithImageInput(model: Model<Api>): Model<Api> {
  return model.input.includes('image')
    ? model
    : { ...model, input: Array.from(new Set([...model.input, 'image'])) } as Model<Api>;
}

function modelWithTextOnlyInput(model: Model<Api>): Model<Api> {
  const input = model.input.filter((item) => item !== 'image');
  return model.input.includes('image')
    ? { ...model, input: input.length > 0 ? input : ['text'] } as Model<Api>
    : model;
}

/**
 * Creates a provider payload that is safe after the provider has explicitly
 * refused image input. It preserves surrounding text and tool results so the
 * same agent turn can continue rather than failing the tool chain.
 */
export function removeImagesAfterProviderRejection(context: Context): Context {
  return {
    ...context,
    messages: context.messages.map((message) => {
      if (!isMessageWithContent(message)) return message;

      const imageCount = message.content.filter(isImagePart).length;
      if (imageCount === 0) return message;

      return {
        ...message,
        content: [
          ...message.content.filter((part) => !isImagePart(part)),
          {
            type: 'text',
            text: `[${imageCount} image${imageCount === 1 ? '' : 's'} omitted after the provider rejected image input for this model.]`,
          },
        ],
      } as Message;
    }),
  };
}

async function pipeStream(
  source: AssistantMessageEventStream,
  destination: AssistantMessageEventStream,
): Promise<void> {
  for await (const event of source) {
    destination.push(event);
  }
}

function unexpectedRelayError(model: Model<Api>, error: unknown): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
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
    errorMessage: error instanceof Error
      ? `The provider stream could not be relayed: ${error.message}`
      : 'The provider stream could not be relayed.',
    timestamp: Date.now(),
  };
}

/**
 * Optimistically sends image context even when local model metadata is stale or
 * incomplete. Only an unambiguous provider rejection before streaming starts
 * triggers one text-only retry. The rejection is remembered for this executable
 * runtime only; it is deliberately not persisted as permanent catalog metadata.
 */
export function createVisionFallbackStreamFn(
  streamFn: StreamFn,
  createStream: () => AssistantMessageEventStream,
): StreamFn {
  let imageInputRejected = false;

  return async (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): Promise<AssistantMessageEventStream> => {
    if (!contextContainsImages(context)) {
      return streamFn(model, context, options);
    }

    if (imageInputRejected) {
      return streamFn(
        modelWithTextOnlyInput(model),
        removeImagesAfterProviderRejection(context),
        options,
      );
    }

    const initial = await streamFn(modelWithImageInput(model), context, options);
    const output = createStream();

    void (async () => {
      const iterator = initial[Symbol.asyncIterator]();
      const buffered = [];
      for (let eventIndex = 0; eventIndex < 2; eventIndex += 1) {
        const next = await iterator.next();
        if (next.done) {
          output.end();
          return;
        }
        buffered.push(next.value);
        // A provider can emit `start` before a request-level image rejection.
        // Hold that protocol-only event until the next event so the fallback can
        // still replace the failed attempt without exposing a partial response.
        if (next.value.type !== 'start') break;
      }

      const last = buffered.at(-1);
      if (
        last?.type === 'error'
        && isImageInputUnsupportedError(last.error.errorMessage ?? '')
      ) {
        imageInputRejected = true;
        const fallback = await streamFn(
          modelWithTextOnlyInput(model),
          removeImagesAfterProviderRejection(context),
          options,
        );
        await pipeStream(fallback, output);
        return;
      }

      for (const event of buffered) output.push(event);
      for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
        output.push(event);
      }
    })().catch((error) => {
      // The wrapped executable runtime already converts request failures into an
      // error stream. Keep this guard only for an unexpected stream-protocol
      // violation so consumers cannot hang waiting for completion.
      output.push({ type: 'error', reason: 'error', error: unexpectedRelayError(model, error) });
      console.error('[Vision Fallback] Failed to relay provider stream:', error);
    });

    return output;
  };
}
