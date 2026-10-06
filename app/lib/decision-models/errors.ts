export type DecisionErrorCode =
  | 'missing_configuration'
  | 'invalid_request'
  | 'unsupported_capability'
  | 'invalid_response'
  | 'endpoint_rejected'
  | 'authentication_failed'
  | 'timeout'
  | 'aborted'
  | 'rate_limited'
  | 'provider_error';

const ERROR_MESSAGES: Record<DecisionErrorCode, string> = {
  missing_configuration: 'The decision provider is not configured.',
  invalid_request: 'The decision request does not match the supported contract.',
  unsupported_capability: 'The decision provider does not support the requested capability.',
  invalid_response: 'The decision provider returned an invalid result.',
  endpoint_rejected: 'The decision provider endpoint is not allowed.',
  authentication_failed: 'The decision provider credentials were rejected.',
  timeout: 'The decision provider request timed out.',
  aborted: 'The decision provider request was cancelled.',
  rate_limited: 'The decision provider is temporarily rate limited.',
  provider_error: 'The decision provider request failed.',
};

/** Fixed messages deliberately exclude input, credentials, response bodies and transport errors. */
export class DecisionModelError extends Error {
  readonly code: DecisionErrorCode;
  readonly providerId?: string;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;

  constructor(code: DecisionErrorCode, options: {
    providerId?: string;
    httpStatus?: number;
    retryAfterMs?: number;
    retryable?: boolean;
  } = {}) {
    super(ERROR_MESSAGES[code]);
    this.name = 'DecisionModelError';
    this.code = code;
    this.providerId = options.providerId;
    this.httpStatus = options.httpStatus;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = options.retryable ?? false;
  }
}
