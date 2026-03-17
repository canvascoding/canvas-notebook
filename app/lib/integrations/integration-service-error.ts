export class IntegrationServiceError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = 'IntegrationServiceError';
    this.statusCode = statusCode;
  }
}
