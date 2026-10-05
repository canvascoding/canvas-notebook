import 'server-only';

export class TranscriptionServiceError extends Error {
  constructor(message: string, public readonly code: string, public readonly status: number) {
    super(message);
    this.name = 'TranscriptionServiceError';
  }
}
