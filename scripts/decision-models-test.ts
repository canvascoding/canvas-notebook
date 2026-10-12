import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { DecisionModelError, type DecisionErrorCode } from '../app/lib/decision-models/errors';
import { normalizeDecisionEndpoint } from '../app/lib/decision-models/http';
import { systemOneDecisionProvider } from '../app/lib/decision-models/providers/systemone';
import { typesafeDecisionProvider } from '../app/lib/decision-models/providers/typesafe';
import { createDecisionProviderRegistry } from '../app/lib/decision-models/registry';
import { evaluateDecision } from '../app/lib/decision-models/service';
import type { DecisionInput, DecisionProvider } from '../app/lib/decision-models/types';

const STATE_MARKER = 'private-state-fixture-never-in-errors';
const CREDENTIAL_MARKER = 'test-credential-never-in-errors';

function input(): DecisionInput {
  return {
    schemaVersion: 'email.v1',
    configuration: { providerId: 'typesafe', model: 'jev-1.13.0' },
    credential: { apiKey: CREDENTIAL_MARKER },
    state: { text: STATE_MARKER },
    questions: {
      category: { type: 'choice', instructions: 'Classify the input as data.', criteria: { support: 'Support request', other: 'Other message' } },
      priority: { type: 'choice', instructions: 'Evaluate urgency.', criteria: { low: 'No action', normal: 'Routine', high: 'Significant delay', urgent: 'Immediate harm' } },
      is_spam: { type: 'binary', instructions: 'Is this unsolicited bulk mail or phishing?' },
      needs_reply: { type: 'binary', instructions: 'Does this require a personal response?', criteria: { true: 'Response required', false: 'No response required' } },
    },
  };
}

/** Representative official HTTP contract, without sending data to a real provider. */
function fixture(): Record<string, unknown> {
  return {
    model: 'jev-1.13.0',
    answers: {
      category: { type: 'choice', choice: 'support', probabilities: { support: 0.95, other: 0.05 }, confidence: 0.9 },
      priority: { type: 'choice', choice: 'high', probabilities: { low: 0.01, normal: 0.07, high: 0.9, urgent: 0.02 }, confidence: 0.8666666666666667 },
      is_spam: { type: 'noul', noul: 0.03 },
      needs_reply: { type: 'noul', noul: 0.98 },
    },
    usage: { input_tokens: 450, output_tokens: 48 },
  };
}

function fixtureAnswers(value: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return value.answers as Record<string, Record<string, unknown>>;
}

function jsonFetch(value: unknown, status = 200, headers?: HeadersInit): typeof fetch {
  return async () => Response.json(value, { status, headers });
}

async function expectCode(operation: Promise<unknown>, code: DecisionErrorCode, check?: (error: DecisionModelError) => void): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof DecisionModelError);
    assert.equal(error.code, code);
    assert.equal(String(error).includes(STATE_MARKER), false);
    assert.equal(String(error).includes(CREDENTIAL_MARKER), false);
    assert.equal(JSON.stringify(error).includes(STATE_MARKER), false);
    assert.equal(JSON.stringify(error).includes(CREDENTIAL_MARKER), false);
    check?.(error);
    return true;
  });
}

async function main(): Promise<void> {
  await testOpenAIDecisions();
  let calls = 0;
  let sentBody: Record<string, unknown> | undefined;
  const captureFetch: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://api.typesafe.ai/v1/systemone');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'manual');
    assert.equal(init?.credentials, 'omit');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${CREDENTIAL_MARKER}`);
    sentBody = JSON.parse(String(init?.body));
    return Response.json(fixture());
  };
  const result = await evaluateDecision(input(), { fetch: captureFetch });
  assert.equal(calls, 1, 'All four questions use one state and one HTTP request.');
  assert.deepEqual(sentBody?.state, { text: STATE_MARKER });
  assert.equal(sentBody?.model, 'jev-1.13.0');
  assert.equal(Object.hasOwn(sentBody!, 'schemaVersion'), false, 'The Canvas schema revision is not an undocumented provider argument.');
  const questions = sentBody?.questions as Record<string, Record<string, unknown>>;
  assert.equal(questions.category.type, 'choice');
  assert.equal(questions.is_spam.type, 'noul');
  assert.equal(questions.needs_reply.type, 'noul');
  assert.deepEqual(questions.needs_reply.criteria, { true: 'Response required', false: 'No response required' });
  assert.deepEqual(result.answers.is_spam, { type: 'binary', probability: 0.03 });
  assert.deepEqual(result.answers.needs_reply, { type: 'binary', probability: 0.98 });
  assert.equal('confidence' in result.answers.is_spam, false);
  assert.equal(result.model, 'jev-1.13.0');
  assert.equal(result.providerId, 'typesafe');
  assert.equal(result.probabilitySemantics, 'model_probability');
  assert.equal(result.calibrationReference, 'https://docs.typesafe.ai/confidence');
  assert.deepEqual(result.usage, { inputTokens: 450, outputTokens: 48, requests: 1 });
  assert.ok(result.latencyMs >= 0);

  const mutableInput = input();
  let resolveMutable: (response: Response) => void = () => undefined;
  const mutableRequest = evaluateDecision(mutableInput, { fetch: () => new Promise(resolve => { resolveMutable = resolve; }) });
  mutableInput.questions.category = { type: 'binary', instructions: 'Mutated contract.' };
  mutableInput.configuration.model = 'changed-model';
  resolveMutable(Response.json(fixture()));
  assert.equal((await mutableRequest).answers.category.type, 'choice', 'In-flight caller mutations cannot alter the validated schema.');

  const ordinalInput = input();
  ordinalInput.questions.frustration = { type: 'ordinal', instructions: 'Evaluate frustration.', criteria: ['Calm', 'Frustrated', 'Very angry'] };
  const ordinalFixture = fixture();
  fixtureAnswers(ordinalFixture).frustration = { type: 'score', score: 1.05, legend: { '0': 'Calm', '1': 'Frustrated', '2': 'Very angry' }, probabilities: { '0': 0, '1': 0.95, '2': 0.05 }, confidence: 0.92 };
  const ordinalResult = await evaluateDecision(ordinalInput, { fetch: async (_, init) => {
    assert.equal(JSON.parse(String(init?.body)).questions.frustration.type, 'score');
    return Response.json(ordinalFixture);
  } });
  assert.equal(ordinalResult.answers.frustration.type, 'ordinal');
  assert.equal(ordinalResult.answers.frustration.type === 'ordinal' && ordinalResult.answers.frustration.score, 1.05);
  fixtureAnswers(ordinalFixture).frustration.score = 0.5;
  await expectCode(evaluateDecision(ordinalInput, { fetch: jsonFetch(ordinalFixture) }), 'invalid_response');

  const compatible = input();
  compatible.configuration = { providerId: 'systemone', model: 'kev-test-version', endpoint: 'http://localhost:8080/v1', allowPrivateNetwork: true };
  compatible.credential = undefined;
  const compatibleFixture = fixture();
  compatibleFixture.model = 'kev-test-version';
  delete compatibleFixture.usage;
  delete fixtureAnswers(compatibleFixture).category.probabilities;
  delete fixtureAnswers(compatibleFixture).category.confidence;
  const compatibleResult = await evaluateDecision(compatible, { fetch: async (url, init) => {
    assert.equal(String(url), 'http://localhost:8080/v1/systemone');
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    return Response.json(compatibleFixture);
  } });
  assert.deepEqual(compatibleResult.answers.category, { type: 'choice', choice: 'support' });
  assert.equal(compatibleResult.usage, undefined);
  assert.equal(compatibleResult.probabilitySemantics, 'relative_probability');
  assert.equal(compatibleResult.calibrationReference, undefined);
  assert.equal(compatibleResult.model, 'kev-test-version');
  assert.equal(normalizeDecisionEndpoint({ providerId: 'systemone', model: 'kev', endpoint: 'https://models.example.test/proxy/v1/systemone' }).href, 'https://models.example.test/proxy/v1/systemone');

  for (const mutate of [
    (value: Record<string, unknown>) => { delete fixtureAnswers(value).category; },
    (value: Record<string, unknown>) => { fixtureAnswers(value).extra = { type: 'noul', noul: 0.5 }; },
    (value: Record<string, unknown>) => { fixtureAnswers(value).category.choice = 'injected'; },
    (value: Record<string, unknown>) => { fixtureAnswers(value).category.probabilities = { support: 0.4, other: 0.4 }; },
    (value: Record<string, unknown>) => { fixtureAnswers(value).category.probabilities = { support: 0.05, other: 0.95 }; },
    (value: Record<string, unknown>) => { fixtureAnswers(value).category.probabilities = { support: 0.9, other: 0.05, extra: 0.05 }; },
    (value: Record<string, unknown>) => { fixtureAnswers(value).category.confidence = 2; },
    (value: Record<string, unknown>) => { fixtureAnswers(value).is_spam.noul = -1; },
    (value: Record<string, unknown>) => { fixtureAnswers(value).is_spam.noul = 1.01; },
    (value: Record<string, unknown>) => { fixtureAnswers(value).is_spam.type = 'boolean'; },
    (value: Record<string, unknown>) => { fixtureAnswers(value).is_spam.noul = '0.03'; },
    (value: Record<string, unknown>) => { fixtureAnswers(value).category.probabilities = undefined; },
    (value: Record<string, unknown>) => { value.model = ''; },
    (value: Record<string, unknown>) => { value.usage = { input_tokens: -1, output_tokens: 1 }; },
  ]) {
    const value = fixture();
    mutate(value);
    await expectCode(evaluateDecision(input(), { fetch: jsonFetch(value) }), 'invalid_response');
  }
  const rounded = fixture();
  fixtureAnswers(rounded).category.probabilities = { support: 0.95, other: 0.04999 };
  await evaluateDecision(input(), { fetch: jsonFetch(rounded) });

  let invalidCalls = 0;
  const invalidFetch: typeof fetch = async () => { invalidCalls++; return Response.json(fixture()); };
  const missingCredential = input();
  missingCredential.credential = undefined;
  await expectCode(evaluateDecision(missingCredential, { fetch: invalidFetch }), 'missing_configuration');
  for (const mutate of [
    (value: DecisionInput) => { value.questions = {}; },
    (value: DecisionInput) => { value.questions.category = { type: 'choice', instructions: 'Decide.', criteria: { only: 'One' } }; },
    (value: DecisionInput) => { value.timeoutMs = 0; },
    (value: DecisionInput) => { value.credential = { apiKey: 'unsafe\r\nkey' }; },
    (value: DecisionInput) => { value.state = { number: Number.NaN }; },
    (value: DecisionInput) => { value.state = { text: 'x'.repeat(129 * 1024) }; },
    (value: DecisionInput) => { value.schemaVersion = ''; },
  ]) {
    const value = input();
    mutate(value);
    await expectCode(evaluateDecision(value, { fetch: invalidFetch }), 'invalid_request');
  }
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  await expectCode(evaluateDecision({ ...input(), state: cycle }, { fetch: invalidFetch }), 'invalid_request');
  assert.equal(invalidCalls, 0, 'Invalid requests are rejected before transport.');

  const limited: DecisionProvider = { ...systemOneDecisionProvider, id: 'limited', capabilities: { ...systemOneDecisionProvider.capabilities, questionTypes: ['choice'] } };
  const limitedRegistry = createDecisionProviderRegistry([limited]);
  await expectCode(evaluateDecision({ ...input(), configuration: { providerId: 'limited', model: 'test' } }, { registry: limitedRegistry, fetch: invalidFetch }), 'unsupported_capability');
  assert.equal(createDecisionProviderRegistry([]).get('typesafe'), undefined);
  const independentRegistry = createDecisionProviderRegistry([limited]);
  limited.capabilities.questionTypes = ['binary'];
  assert.deepEqual(independentRegistry.get('limited')?.capabilities.questionTypes, ['choice'], 'Registries snapshot provider capabilities independently.');
  assert.throws(() => createDecisionProviderRegistry([typesafeDecisionProvider, typesafeDecisionProvider]), DecisionModelError);
  await expectCode(evaluateDecision({ ...input(), configuration: { providerId: 'unknown', model: 'test' } }, { fetch: invalidFetch }), 'missing_configuration');
  assert.equal(invalidCalls, 0, 'An unknown provider does not invoke a fallback.');
  const unsafeExtra: DecisionProvider = {
    ...systemOneDecisionProvider,
    id: 'extra',
    evaluate: async () => ({ model: 'test', answers: { answer: { type: 'binary', probability: 0.1, rawInput: STATE_MARKER } }, rawInput: STATE_MARKER }),
  };
  const projected = await evaluateDecision({ ...input(), configuration: { providerId: 'extra', model: 'test' }, questions: { answer: { type: 'binary', instructions: 'Decide.' } } }, { registry: createDecisionProviderRegistry([unsafeExtra]) });
  assert.equal(JSON.stringify(projected).includes(STATE_MARKER), false, 'Only normalized contract fields are returned.');

  for (const endpoint of ['file:///etc/passwd', 'http://localhost:8080', 'https://user:password@model.example.test', 'https://model.example.test/?key=x', 'https://model.example.test/#fragment']) {
    await expectCode(evaluateDecision({ ...compatible, configuration: { ...compatible.configuration, endpoint, allowPrivateNetwork: false } }, { fetch: invalidFetch }), 'endpoint_rejected');
  }
  for (const endpoint of ['http://169.254.169.254', 'http://0.0.0.0:8080', 'http://[::]:8080', 'http://[fe90::1]:8080', 'http://[::ffff:169.254.169.254]:8080', 'http://metadata.google.internal']) {
    await expectCode(evaluateDecision({ ...compatible, configuration: { ...compatible.configuration, endpoint } }, { fetch: invalidFetch }), 'endpoint_rejected');
  }
  await expectCode(evaluateDecision({ ...input(), configuration: { ...input().configuration, endpoint: 'https://other.example.test' } }, { fetch: invalidFetch }), 'endpoint_rejected');
  assert.equal(invalidCalls, 0);

  await expectCode(evaluateDecision(input(), { fetch: jsonFetch({ error: STATE_MARKER }, 429, { 'retry-after': '5' }) }), 'rate_limited', error => {
    assert.equal(error.httpStatus, 429);
    assert.equal(error.retryAfterMs, 5000);
    assert.equal(error.retryable, true);
  });
  await expectCode(evaluateDecision(input(), { fetch: jsonFetch({ error: STATE_MARKER }, 529) }), 'rate_limited');
  await expectCode(evaluateDecision(input(), { fetch: jsonFetch({ error: STATE_MARKER }, 401) }), 'authentication_failed');
  await expectCode(evaluateDecision(input(), { fetch: jsonFetch({ error: STATE_MARKER }, 422) }), 'provider_error', error => assert.equal(error.retryable, false));
  await expectCode(evaluateDecision(input(), { fetch: jsonFetch({ error: STATE_MARKER }, 503) }), 'provider_error', error => assert.equal(error.retryable, true));
  let redirectCalls = 0;
  await expectCode(evaluateDecision(input(), { fetch: async (_, init) => {
    redirectCalls++;
    assert.equal(init?.redirect, 'manual');
    return new Response(null, { status: 307, headers: { location: 'http://localhost/private' } });
  } }), 'provider_error');
  assert.equal(redirectCalls, 1, 'Redirect responses are never followed.');
  await expectCode(evaluateDecision(input(), { fetch: async () => { throw new Error(`${STATE_MARKER} ${CREDENTIAL_MARKER}`); } }), 'provider_error');
  await expectCode(evaluateDecision(input(), { fetch: async () => new Response('not JSON ' + STATE_MARKER) }), 'invalid_response');
  await expectCode(evaluateDecision(input(), { fetch: async () => new Response('{}', { headers: { 'content-length': String(1024 * 1024) } }) }), 'invalid_response');
  await expectCode(evaluateDecision(input(), { fetch: async () => new Response('x'.repeat(513 * 1024)) }), 'invalid_response');

  const preAborted = new AbortController();
  preAborted.abort(STATE_MARKER);
  await expectCode(evaluateDecision({ ...input(), signal: preAborted.signal }, { fetch: invalidFetch }), 'aborted');
  const externalAbort = new AbortController();
  const interrupted = evaluateDecision({ ...input(), signal: externalAbort.signal }, { fetch: async (_, init) => {
    assert.ok(init?.signal);
    externalAbort.abort(STATE_MARKER);
    return new Promise<Response>(() => undefined);
  } });
  await expectCode(interrupted, 'aborted');
  let timeoutSignal: AbortSignal | null | undefined;
  await expectCode(evaluateDecision({ ...input(), timeoutMs: 15 }, { fetch: async (_, init) => {
    timeoutSignal = init?.signal;
    return new Promise<Response>(() => undefined);
  } }), 'timeout', error => assert.equal(error.retryable, true));
  assert.equal(timeoutSignal?.aborted, true);
  let cancelledStream = false;
  await expectCode(evaluateDecision({ ...input(), timeoutMs: 15 }, { fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
    cancel() { cancelledStream = true; },
  })) }), 'timeout');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(cancelledStream, true, 'The timeout also cancels an unfinished response body.');

  // Exercise the real DNS-pinned POST transport against a fixture, never against a real model.
  let localBody = '';
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/v1/systemone');
    assert.equal(request.method, 'POST');
    request.setEncoding('utf8');
    request.on('data', chunk => { localBody += chunk; });
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(fixture()));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const localInput = { ...compatible, configuration: { ...compatible.configuration, endpoint: `http://127.0.0.1:${address.port}` } };
    const local = await evaluateDecision(localInput);
    assert.equal(local.answers.category.type, 'choice');
    assert.deepEqual(JSON.parse(localBody).state, { text: STATE_MARKER });
    await expectCode(evaluateDecision({ ...localInput, configuration: { ...localInput.configuration, allowPrivateNetwork: false } }), 'endpoint_rejected');
  } finally {
    server.close();
    await once(server, 'close');
  }
  console.log('Decision model contract, validation, transport and cancellation tests passed.');
}

function openAIInput(): DecisionInput {
  return { ...input(), configuration: { providerId: 'openai-decisions', model: 'gpt-6-luna' }, questions: {
    ...input().questions, severity: { type: 'ordinal', instructions: 'Evaluate severity.', criteria: ['Cosmetic', 'Workaround available', 'Fully blocked'] },
  } };
}

function openAIFixture(): Record<string, unknown> {
  return {
    model: 'gpt-6-luna',
    answers: [
      { name: 'category', type: 'choice', choice: 'support', probabilities: [{ value: 'support', probability: 0.95 }, { value: 'other', probability: 0.05 }], confidence: 0.9 },
      { name: 'priority', type: 'choice', choice: 'high', probabilities: [{ value: 'low', probability: 0.01 }, { value: 'normal', probability: 0.07 }, { value: 'high', probability: 0.9 }, { value: 'urgent', probability: 0.02 }], confidence: 0.8666666666666667 },
      { name: 'is_spam', type: 'predicate', probability: 0.03 },
      { name: 'needs_reply', type: 'predicate', probability: 0.98 },
      { name: 'severity', type: 'score', score: 1.1, probabilities: [{ value: 0, label: '0', probability: 0.1 }, { value: 1, label: '1', probability: 0.7 }, { value: 2, label: '2', probability: 0.2 }], confidence: 0.55 },
    ],
    usage: { input_tokens: 450, output_tokens: 0, total_tokens: 450, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
  };
}

function openAIAnswer(value: Record<string, unknown>, name: string): Record<string, unknown> {
  const answer = (value.answers as Record<string, unknown>[]).find(item => item.name === name);
  assert.ok(answer);
  return answer;
}

async function testOpenAIDecisions(): Promise<void> {
  let calls = 0;
  const request = openAIInput();
  const result = await evaluateDecision(request, { fetch: async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://api.openai.com/v1/decisions');
    assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'manual'); assert.equal(init?.credentials, 'omit');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${CREDENTIAL_MARKER}`);
    const sent = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(sent).sort(), ['input', 'model', 'questions']);
    assert.equal(sent.model, 'gpt-6-luna'); assert.deepEqual(JSON.parse(sent.input), request.state);
    assert.equal(JSON.stringify(sent).includes(CREDENTIAL_MARKER), false);
    assert.deepEqual(sent.questions[0], { name: 'category', type: 'choice', instructions: request.questions.category.instructions,
      choices: [{ value: 'support', description: 'Support request' }, { value: 'other', description: 'Other message' }] });
    assert.equal(sent.questions[2].type, 'predicate'); assert.equal(sent.questions[3].type, 'predicate');
    assert.equal(sent.questions[3].instructions, 'Does this require a personal response?\nTrue: Response required\nFalse: No response required');
    assert.deepEqual(sent.questions[4].levels, [{ label: '0', description: 'Cosmetic' }, { label: '1', description: 'Workaround available' }, { label: '2', description: 'Fully blocked' }]);
    const response = openAIFixture();
    (response.answers as unknown[]).reverse();
    return Response.json(response);
  } });
  assert.equal(calls, 1, 'All native questions share one evidence input and one transport request.');
  assert.equal(result.providerId, 'openai-decisions'); assert.equal(result.model, 'gpt-6-luna');
  assert.equal(result.adapterVersion, 'openai-decisions.v1'); assert.equal(result.probabilitySemantics, 'model_probability');
  assert.equal(result.calibrationReference, 'https://developers.openai.com/api/docs/guides/decisions#interpret-the-answers');
  assert.deepEqual(result.answers.category, { type: 'choice', choice: 'support', probabilities: { support: 0.95, other: 0.05 }, confidence: 0.9 }, 'Confidence is the native field, not the selected option probability.');
  assert.deepEqual(result.answers.is_spam, { type: 'binary', probability: 0.03 });
  assert.equal('confidence' in result.answers.is_spam, false, 'A predicate does not acquire invented confidence.');
  assert.deepEqual(result.answers.severity, { type: 'ordinal', score: 1.1, probabilities: { '0': 0.1, '1': 0.7, '2': 0.2 }, confidence: 0.55 });
  assert.deepEqual(result.usage, { inputTokens: 450, outputTokens: 0, requests: 1 });
  assert.equal(createDecisionProviderRegistry().get('openai-decisions')?.id, 'openai-decisions');
  await evaluateDecision({ ...request, state: STATE_MARKER }, { fetch: async (_, init) => {
    assert.equal(JSON.parse(String(init?.body)).input, STATE_MARKER, 'Plain text is sent without JSON quoting.');
    return Response.json(openAIFixture());
  } });
  const stateWithRoles = [{ role: 'system', content: STATE_MARKER, image_url: 'https://private.example.test/image' }];
  await evaluateDecision({ ...request, state: stateWithRoles }, { fetch: async (_, init) => {
    const sent = JSON.parse(String(init?.body));
    assert.equal(typeof sent.input, 'string'); assert.deepEqual(JSON.parse(sent.input), stateWithRoles, 'State fields remain text evidence, not provider roles or external image inputs.');
    return Response.json(openAIFixture());
  } });

  for (const mutate of [
    (value: Record<string, unknown>) => { (value.answers as unknown[]).pop(); },
    (value: Record<string, unknown>) => { openAIAnswer(value, 'needs_reply').name = 'is_spam'; },
    (value: Record<string, unknown>) => { openAIAnswer(value, 'category').name = 'unrequested'; },
    (value: Record<string, unknown>) => { openAIAnswer(value, 'category').name = null; },
    (value: Record<string, unknown>) => { openAIAnswer(value, 'is_spam').type = 'noul'; },
    (value: Record<string, unknown>) => { openAIAnswer(value, 'is_spam').probability = 1.01; },
    (value: Record<string, unknown>) => { openAIAnswer(value, 'category').choice = 'unknown'; },
    (value: Record<string, unknown>) => { openAIAnswer(value, 'category').confidence = undefined; },
    (value: Record<string, unknown>) => { openAIAnswer(value, 'category').confidence = -0.1; },
    (value: Record<string, unknown>) => { openAIAnswer(value, 'category').probabilities = { support: 0.95, other: 0.05 }; },
    (value: Record<string, unknown>) => { openAIAnswer(value, 'category').probabilities = [{ value: 'support', probability: 0.95 }, { value: 'support', probability: 0.05 }]; },
    (value: Record<string, unknown>) => { openAIAnswer(value, 'category').probabilities = [{ value: 'support', probability: 0.5 }, { value: 'other', probability: 0.4 }]; },
    (value: Record<string, unknown>) => { openAIAnswer(value, 'category').probabilities = [{ value: 'support', probability: 0.05 }, { value: 'other', probability: 0.95 }]; },
    (value: Record<string, unknown>) => { openAIAnswer(value, 'category').probabilities = [{ value: 'support', probability: 1 }]; },
    (value: Record<string, unknown>) => { openAIAnswer(value, 'severity').score = 0.5; },
    (value: Record<string, unknown>) => { const probabilities = openAIAnswer(value, 'severity').probabilities as Record<string, unknown>[]; probabilities[0].value = '0'; },
    (value: Record<string, unknown>) => { const probabilities = openAIAnswer(value, 'severity').probabilities as Record<string, unknown>[]; probabilities[0].label = 'wrong-level'; },
    (value: Record<string, unknown>) => { value.model = 'other-model'; },
    (value: Record<string, unknown>) => { delete value.usage; },
    (value: Record<string, unknown>) => { value.usage = { input_tokens: -1, output_tokens: 0 }; },
  ]) {
    const fixture = openAIFixture(); mutate(fixture);
    await expectCode(evaluateDecision(request, { fetch: jsonFetch(fixture) }), 'invalid_response');
  }
  for (const name of ['category', 'is_spam', 'severity']) {
    const fixture = openAIFixture();
    Object.assign(openAIAnswer(fixture, name), { type: 'refusal', reason: `${STATE_MARKER} ${CREDENTIAL_MARKER}` });
    await expectCode(evaluateDecision(request, { fetch: jsonFetch(fixture) }), 'refused', error => assert.equal(error.retryable, false));
  }
  let rejectedCalls = 0;
  const rejectedFetch: typeof fetch = async () => { rejectedCalls++; return Response.json(openAIFixture()); };
  await expectCode(evaluateDecision({ ...request, credential: undefined }, { fetch: rejectedFetch }), 'missing_configuration');
  await expectCode(evaluateDecision({ ...request, state: { text: '"'.repeat(65_500) } }, { fetch: rejectedFetch }), 'invalid_request');
  await expectCode(evaluateDecision({ ...request, configuration: { ...request.configuration, model: 'gpt-6-sol' } }, { fetch: rejectedFetch }), 'unsupported_capability');
  for (const endpoint of ['https://api.openai.com/v1/responses', 'https://other.example.test/v1/decisions', 'http://127.0.0.1:8080/v1/decisions', 'https://api.openai.com/v1/decisions?key=x']) {
    await expectCode(evaluateDecision({ ...request, configuration: { ...request.configuration, endpoint, allowPrivateNetwork: true } }, { fetch: rejectedFetch }), 'endpoint_rejected');
  }
  assert.equal(rejectedCalls, 0, 'OpenAI has no model, credential or endpoint fallback.');
  assert.equal(normalizeDecisionEndpoint({ ...request.configuration, allowPrivateNetwork: true }).href, 'https://api.openai.com/v1/decisions');
  await expectCode(evaluateDecision(request, { fetch: jsonFetch({ error: STATE_MARKER }, 429, { 'retry-after': '3' }) }), 'rate_limited', error => {
    assert.equal(error.httpStatus, 429); assert.equal(error.retryAfterMs, 3000); assert.equal(error.retryable, true);
  });
  await expectCode(evaluateDecision(request, { fetch: jsonFetch({ error: STATE_MARKER }, 401) }), 'authentication_failed');
  await expectCode(evaluateDecision(request, { fetch: jsonFetch({ error: STATE_MARKER }, 503) }), 'provider_error', error => assert.equal(error.retryable, true));
  let redirects = 0;
  await expectCode(evaluateDecision(request, { fetch: async (_, init) => {
    redirects++; assert.equal(init?.redirect, 'manual');
    return new Response(null, { status: 307, headers: { location: 'https://other.example.test' } });
  } }), 'provider_error');
  assert.equal(redirects, 1);
  await expectCode(evaluateDecision(request, { fetch: async () => new Response('x'.repeat(513 * 1024)) }), 'invalid_response');
  const controller = new AbortController();
  await expectCode(evaluateDecision({ ...request, signal: controller.signal }, { fetch: async () => {
    controller.abort(STATE_MARKER); return new Promise<Response>(() => undefined);
  } }), 'aborted');
  let timeoutSignal: AbortSignal | null | undefined;
  await expectCode(evaluateDecision({ ...request, timeoutMs: 15 }, { fetch: async (_, init) => {
    timeoutSignal = init?.signal; return new Promise<Response>(() => undefined);
  } }), 'timeout');
  assert.equal(timeoutSignal?.aborted, true);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
