import 'server-only';

import { ollamaTagsUrl } from '@/app/lib/agent-runtime-policy/ollama-url';

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+~-]{0,199}$/u;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 512;
const DISCOVERY_TIMEOUT_MS = 10_000;

type FetchImplementation = typeof fetch;

type OllamaTagsPayload = {
  models?: Array<{
    name?: unknown;
    model?: unknown;
    modified_at?: unknown;
    size?: unknown;
    digest?: unknown;
  }>;
};

export type OllamaDiscoveredModel = {
  id: string;
  name: string;
  modifiedAt: string | null;
  size: number | null;
  digest: string | null;
};

export class OllamaDiscoveryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 502,
  ) {
    super(message);
    this.name = 'OllamaDiscoveryError';
  }
}

async function readLimitedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new OllamaDiscoveryError('OLLAMA_RESPONSE_TOO_LARGE', 'The Ollama model response is too large.');
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new OllamaDiscoveryError('OLLAMA_RESPONSE_TOO_LARGE', 'The Ollama model response is too large.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new OllamaDiscoveryError('OLLAMA_INVALID_RESPONSE', 'The Ollama server returned invalid JSON.');
  }
}

export async function discoverOllamaModels(input: {
  serverUrl: string;
  apiKey?: string;
  signal?: AbortSignal;
}, dependencies: { fetchImpl?: FetchImplementation } = {}): Promise<OllamaDiscoveredModel[]> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const timeoutSignal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetchImpl(ollamaTagsUrl(input.serverUrl), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(input.apiKey?.trim() ? { Authorization: `Bearer ${input.apiKey.trim()}` } : {}),
      },
      redirect: 'error',
      cache: 'no-store',
      signal,
    });
  } catch (error) {
    if (signal.aborted) {
      throw new OllamaDiscoveryError('OLLAMA_CONNECTION_TIMEOUT', 'The Ollama server did not respond in time.', 504);
    }
    throw new OllamaDiscoveryError(
      'OLLAMA_CONNECTION_FAILED',
      error instanceof Error ? `Could not reach the Ollama server: ${error.message}` : 'Could not reach the Ollama server.',
    );
  }
  if (!response.ok) {
    throw new OllamaDiscoveryError(
      'OLLAMA_CONNECTION_REJECTED',
      `The Ollama server returned HTTP ${response.status}.`,
      response.status === 401 || response.status === 403 ? response.status : 502,
    );
  }

  const payload = await readLimitedJson(response) as OllamaTagsPayload | null;
  if (!payload || !Array.isArray(payload.models)) {
    throw new OllamaDiscoveryError('OLLAMA_INVALID_RESPONSE', 'The Ollama server response does not contain a model list.');
  }
  const models = new Map<string, OllamaDiscoveredModel>();
  for (const entry of payload.models.slice(0, MAX_MODELS)) {
    const id = typeof entry.model === 'string' && entry.model.trim()
      ? entry.model.trim()
      : typeof entry.name === 'string'
        ? entry.name.trim()
        : '';
    if (!MODEL_ID_PATTERN.test(id)) continue;
    models.set(id, {
      id,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id,
      modifiedAt: typeof entry.modified_at === 'string' ? entry.modified_at : null,
      size: typeof entry.size === 'number' && Number.isFinite(entry.size) ? entry.size : null,
      digest: typeof entry.digest === 'string' && entry.digest.trim() ? entry.digest.trim() : null,
    });
  }
  return Array.from(models.values()).sort((left, right) => left.name.localeCompare(right.name));
}
