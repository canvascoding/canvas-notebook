import assert from 'node:assert/strict';
import { APIError, APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from 'openai/error';
import {
  classifyStudioGenerationFailure,
  StudioGenerationFailureError,
  studioGenerationFailureHttpStatus,
} from '../app/lib/integrations/studio-generation-failures';
import { StudioServiceError } from '../app/lib/integrations/studio-errors';
import { IntegrationServiceError } from '../app/lib/integrations/integration-service-error';

const providerError = (message: string, fields: Record<string, unknown> = {}) => Object.assign(new Error(message), fields);

for (const [status, code, retryable] of [
  [400, 'INVALID_PROVIDER_REQUEST', false],
  [401, 'PROVIDER_AUTH_ERROR', false],
  [403, 'PROVIDER_AUTH_ERROR', false],
  [408, 'PROVIDER_TIMEOUT', false],
  [429, 'PROVIDER_RATE_LIMIT', true],
  [500, 'PROVIDER_UNAVAILABLE', true],
  [503, 'PROVIDER_UNAVAILABLE', true],
  [504, 'PROVIDER_TIMEOUT', false],
] as const) {
  const technicalMessage = `${status} provider rejection for input_fidelity`;
  const failure = classifyStudioGenerationFailure(providerError(technicalMessage, { status, requestID: 'req_failure_fixture', param: 'input_fidelity' }));
  assert.equal(failure.code, code);
  assert.equal(failure.retryable, retryable);
  assert.equal(failure.status, status);
  assert.equal(failure.requestId, 'req_failure_fixture');
  assert.equal(failure.details, technicalMessage, 'Provider details must remain available independently of the user message.');
  assert.ok(failure.message.length > 0);
  assert.notEqual(failure.message, technicalMessage, 'HTTP failures need an actionable user message.');
  if (status === 401 || status === 403) assert.match(failure.message, /\/settings\?tab=secrets/u);
  const responseStatus = status === 400 ? 400 : status === 408 || status === 504 ? 504 : status === 429 ? 429 : 502;
  assert.equal(studioGenerationFailureHttpStatus(failure), responseStatus, 'A provider failure must not expire the application session.');
}

const managedTimeout = classifyStudioGenerationFailure(new IntegrationServiceError('Control Plane upstream timeout', 504));
assert.equal(managedTimeout.status, 504);
assert.equal(managedTimeout.code, 'PROVIDER_TIMEOUT');
assert.equal(studioGenerationFailureHttpStatus(managedTimeout), 504);
const managedJobFailure = classifyStudioGenerationFailure(new IntegrationServiceError("400 The model does not support input_fidelity; key sk-fixtureSecret1234567890", 502));
assert.equal(managedJobFailure.code, 'MANAGED_MEDIA_FAILED');
assert.equal(managedJobFailure.status, 502, 'A terminal Managed job does not provide the original provider HTTP status.');
assert.equal(managedJobFailure.retryable, false, 'An ambiguous gateway job failure must not encourage automatic retries.');
assert.match(managedJobFailure.message, /does not support input_fidelity/u);
assert.equal(managedJobFailure.message.includes('sk-fixtureSecret1234567890'), false);
assert.equal(studioGenerationFailureHttpStatus(managedJobFailure), 502);
assert.equal(classifyStudioGenerationFailure(providerError('Bad gateway', { status: 502 })).code, 'PROVIDER_UNAVAILABLE', 'An actual provider 502 remains distinct from the Managed job wrapper.');
for (const message of ['OpenAI API key is missing. Configure OPENAI_API_KEY in /settings?tab=secrets.', 'Managed OpenAI image generation is not configured.']) {
  const failure = classifyStudioGenerationFailure(new Error(message));
  assert.equal(failure.code, 'PROVIDER_AUTH_ERROR');
  assert.equal(failure.retryable, false);
  assert.equal(studioGenerationFailureHttpStatus(failure), 502);
}

for (const [name, code, retryable] of [
  ['APIConnectionError', 'PROVIDER_UNAVAILABLE', true],
  ['APIConnectionTimeoutError', 'PROVIDER_TIMEOUT', false],
  ['AbortError', 'PROVIDER_TIMEOUT', false],
] as const) {
  const failure = classifyStudioGenerationFailure(providerError('Network request failed', { name }));
  assert.equal(failure.code, code);
  assert.equal(failure.retryable, retryable);
  assert.equal(failure.status, undefined);
}
assert.equal(classifyStudioGenerationFailure(providerError('socket timeout', { code: 'ETIMEDOUT' })).code, 'PROVIDER_TIMEOUT');
for (const error of [new APIConnectionTimeoutError(), new APIUserAbortError()]) {
  assert.equal(error.name, 'Error', 'The actual SDK subclasses do not set a distinctive Error.name.');
  const failure = classifyStudioGenerationFailure(error);
  assert.equal(failure.code, 'PROVIDER_TIMEOUT');
  assert.equal(failure.retryable, false);
  assert.equal(failure.status, undefined);
}
assert.equal(classifyStudioGenerationFailure(new APIConnectionError({})).code, 'PROVIDER_UNAVAILABLE');

// SDK streaming errors can carry an API code without an HTTP status.
for (const [providerCode, code, retryable, responseStatus] of [
  ['rate_limit_exceeded', 'PROVIDER_RATE_LIMIT', true, 429],
  ['insufficient_quota', 'PROVIDER_RATE_LIMIT', false, 429],
  ['invalid_api_key', 'PROVIDER_AUTH_ERROR', false, 502],
  ['permission_denied', 'PROVIDER_AUTH_ERROR', false, 502],
  ['unsupported_parameter', 'INVALID_PROVIDER_REQUEST', false, 400],
  ['invalid_parameter', 'INVALID_PROVIDER_REQUEST', false, 400],
  ['invalid_request_error', 'INVALID_PROVIDER_REQUEST', false, 400],
  ['server_error', 'PROVIDER_UNAVAILABLE', true, 502],
  ['internal_error', 'PROVIDER_UNAVAILABLE', true, 502],
] as const) {
  const sdkError = new APIError(undefined, { code: providerCode, message: `Stream provider failure: ${providerCode}` }, undefined, undefined);
  assert.equal(sdkError.status, undefined);
  const failure = classifyStudioGenerationFailure(sdkError);
  assert.equal(failure.code, code);
  assert.equal(failure.retryable, retryable);
  assert.equal(failure.status, undefined);
  assert.equal(Object.hasOwn(failure, 'status'), false, 'Code classification must not invent a provider HTTP status.');
  assert.equal(studioGenerationFailureHttpStatus(failure), responseStatus);
  assert.equal(failure.details, sdkError.message);
  assert.equal(sdkError.status, undefined, 'Classification must preserve the original SDK exception.');
}

for (const code of ['moderation_blocked', 'content_policy_violation']) {
  const failure = classifyStudioGenerationFailure(providerError('The input was rejected during a safety check.', { status: 400, code }));
  assert.equal(failure.code, 'PROVIDER_MODERATION_BLOCKED', 'Moderation is more specific than a generic HTTP 400.');
  assert.equal(failure.retryable, false);
}

for (const message of [
  'No image was returned by OpenAI',
  'No final image was returned by OpenAI',
  'No image was returned by managed OpenAI',
]) {
  const failure = classifyStudioGenerationFailure(new Error(message));
  assert.equal(failure.code, 'PROVIDER_EMPTY_RESULT');
  assert.equal(failure.retryable, false, 'No final image must not cause a silent second paid generation.');
  assert.equal(failure.details, message);
}

for (const message of [
  'An edit mask requires at least one reference image.',
  'The edit mask must have the same dimensions as the first reference image.',
  'Reference image 1 must use PNG, JPEG or WebP.',
  'OpenAI supports at most 16 reference images.',
  'Model must be one of: gpt-image-2.5-sunburst, gpt-image-2.5-flare.',
  'Unsupported OpenAI image quality.',
  'Quality must be one of: auto, low, medium, high, xhigh, max.',
  'Output format must be one of: png, jpeg, webp.',
  'Background must be one of: auto, opaque, transparent.',
  'Moderation must be one of: auto, low.',
  'Input fidelity must be one of: low, high.',
  'Output compression must be an integer between 0 and 100.',
  'Invalid image size: Width and height must be divisible by 16.',
  'Stream must be a boolean.',
  'Partial image count must be an integer between 0 and 3.',
  'Partial images require streaming mode.',
  'Image count must be an integer between 1 and 10.',
]) {
  const failure = classifyStudioGenerationFailure(new Error(message));
  assert.equal(failure.code, 'INVALID_IMAGE_OPTIONS', message);
  assert.equal(failure.retryable, false);
  assert.equal(failure.details, message);
}

const serviceError = new StudioServiceError('Workspace technical detail', 'Diese Referenz gehört zu einem anderen Workspace.', 'FORBIDDEN');
const serviceFailure = classifyStudioGenerationFailure(serviceError);
assert.equal(serviceFailure.code, 'FORBIDDEN');
assert.equal(serviceFailure.message, serviceError.userMessage);
assert.equal(serviceFailure.details, serviceError.message);
assert.equal(serviceFailure.retryable, false);
assert.equal(classifyStudioGenerationFailure(new StudioServiceError('A specific service error', 'Bitte wähle eine andere Referenz.')).code, 'GENERATION_FAILED');

const providerFailure = classifyStudioGenerationFailure(providerError('400 unsupported input_fidelity', { status: 400, requestID: 'req_fixture' }));
const wrapped = new StudioGenerationFailureError(providerFailure);
assert.ok(wrapped instanceof StudioServiceError);
assert.ok(wrapped instanceof Error);
assert.equal(wrapped.code, providerFailure.code);
assert.equal(wrapped.userMessage, providerFailure.message);
assert.equal(wrapped.message, providerFailure.details);
assert.equal(wrapped.failure, providerFailure);
assert.equal(classifyStudioGenerationFailure(wrapped), providerFailure, 'A wrapping service boundary must preserve the original structured failure.');

const credentials = [
  'sk-fixtureSecret1234567890',
  'key-fixtureSecret1234567890',
  'token-fixtureSecret1234567890',
  'AIzaFixtureGoogleSecret123456789012345',
  'fixture.bearer.secret',
];
const sensitiveDetails = `400 rejected credentials ${credentials.slice(0, 4).join(' ')} Authorization: Bearer ${credentials[4]}`;
const sanitized = classifyStudioGenerationFailure(providerError(sensitiveDetails, { status: 400 }));
for (const credential of credentials) {
  assert.equal(JSON.stringify(sanitized).includes(credential), false, 'No provider credential may appear in the structured failure.');
}
assert.match(sanitized.details, /\[redacted\]/u);
assert.match(sanitized.details, /Bearer \[redacted\]/u);
const sanitizedService = classifyStudioGenerationFailure(new StudioServiceError(sensitiveDetails, `Zugang ${credentials[0]} fehlt.`, 'PROVIDER_AUTH_ERROR'));
assert.equal(sanitizedService.message.includes(credentials[0]), false, 'Service-provided human messages must be scrubbed as well.');
assert.equal(sanitizedService.details.includes(credentials[0]), false);

const longFailure = classifyStudioGenerationFailure(providerError('x'.repeat(600), { requestID: 'r'.repeat(150) }));
assert.equal(longFailure.details.length, 500);
assert.equal(longFailure.requestId?.length, 100);
const dtoFailure = classifyStudioGenerationFailure({ status: 429, message: 'Managed provider quota reached', requestID: 'req_managed' });
assert.equal(dtoFailure.code, 'PROVIDER_RATE_LIMIT');
assert.equal(dtoFailure.requestId, 'req_managed');
assert.equal(dtoFailure.details, 'Managed provider quota reached');

for (const value of [undefined, null, 'unexpected rejection', 42, {}]) {
  const failure = classifyStudioGenerationFailure(value);
  assert.equal(failure.code, 'GENERATION_FAILED');
  assert.equal(failure.retryable, false);
  assert.ok(failure.message.length > 0);
  assert.ok(failure.details.length <= 500);
}

console.log('studio-generation-failures-test: structured provider/service errors, safe details and wrapper propagation passed');
