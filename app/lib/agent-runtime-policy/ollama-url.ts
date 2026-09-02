const DEFAULT_OLLAMA_SERVER_URL = 'http://localhost:11434';

export class OllamaServerUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OllamaServerUrlError';
  }
}

export function normalizeOllamaServerUrl(value: string | undefined): string {
  const configured = value?.trim() || DEFAULT_OLLAMA_SERVER_URL;
  try {
    const parsed = new URL(configured);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) {
      throw new Error('unsafe URL');
    }
    parsed.pathname = parsed.pathname
      .replace(/\/+$/u, '')
      .replace(/\/v1$/u, '')
      .replace(/\/+$/u, '');
    return parsed.toString().replace(/\/$/u, '');
  } catch {
    throw new OllamaServerUrlError(
      'Enter a valid HTTP(S) Ollama server URL without credentials, query parameters, or fragments.',
    );
  }
}

function appendOllamaPath(serverUrl: string | undefined, suffix: string): string {
  return `${normalizeOllamaServerUrl(serverUrl)}${suffix}`;
}

export function ollamaOpenAiBaseUrl(serverUrl: string | undefined): string {
  return appendOllamaPath(serverUrl, '/v1');
}

export function ollamaTagsUrl(serverUrl: string | undefined): string {
  return appendOllamaPath(serverUrl, '/api/tags');
}

export function defaultOllamaServerUrl(): string {
  return DEFAULT_OLLAMA_SERVER_URL;
}
