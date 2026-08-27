import 'server-only';

export class EmailMessageNotFoundError extends Error {
  readonly code = 'EMAIL_MESSAGE_NOT_FOUND';

  constructor() {
    super('Email message not found.');
    this.name = 'EmailMessageNotFoundError';
  }
}

export class EmailProviderRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'EmailProviderRequestError';
  }
}

export function isEmailMessageNotFoundError(error: unknown): error is EmailMessageNotFoundError {
  return error instanceof EmailMessageNotFoundError;
}

export function isEmailProviderNotFoundError(error: unknown): boolean {
  return error instanceof EmailProviderRequestError && error.status === 404;
}
