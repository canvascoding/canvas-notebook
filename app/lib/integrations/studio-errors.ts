export class StudioServiceError extends Error {
  constructor(
    message: string,
    public readonly userMessage: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'StudioServiceError';
  }
}