import type { Api, Model, SimpleStreamOptions } from '@earendil-works/pi-ai';

type TemperatureCompat = {
  supportsTemperature?: boolean;
};

/**
 * Some reasoning-model APIs reject an explicit temperature entirely. Keep the
 * provider-specific knowledge at the request boundary so background Harness
 * work (titles, summaries, and automation runs) cannot leak it to a provider.
 */
export function omitUnsupportedTemperature(
  model: Model<Api>,
  options?: SimpleStreamOptions,
): SimpleStreamOptions | undefined {
  if (options?.temperature === undefined) return options;

  const compat = model.compat as TemperatureCompat | undefined;
  const modelId = model.id.toLowerCase();
  const isOpenAiReasoningModel = model.api === 'openai-responses'
    && (/^gpt-5(?:[.-]|$)/u.test(modelId) || /^(?:o1|o3|o4)(?:[.-]|$)/u.test(modelId));

  if (compat?.supportsTemperature !== false && !isOpenAiReasoningModel) {
    return options;
  }

  const { temperature: _temperature, ...optionsWithoutTemperature } = options;
  return optionsWithoutTemperature;
}
