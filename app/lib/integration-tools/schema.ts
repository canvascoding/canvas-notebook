import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  IntegrationContractError,
  type IntegrationExecutionContext,
  type IntegrationPolicy,
} from './contracts';

export const INTEGRATION_SCHEMA_LIMITS = Object.freeze({
  schemaBytes: 256 * 1024,
  argumentBytes: 1024 * 1024,
  depth: 64,
  nodes: 20_000,
  workerTimeoutMs: 2_000,
  workerMemoryMb: 64,
  concurrentWorkers: 2,
  queuedWorkers: 16,
});

type Schema = Record<string, unknown> | boolean;
type Dialect = 'draft07' | 'draft2019' | 'draft2020';
const DIALECTS: Readonly<Record<string, Dialect>> = {
  'http://json-schema.org/draft-07/schema': 'draft07',
  'https://json-schema.org/draft-07/schema': 'draft07',
  'https://json-schema.org/draft/2019-09/schema': 'draft2019',
  'https://json-schema.org/draft/2020-12/schema': 'draft2020',
};
const SUPPORTED_VOCABULARIES = new Set([
  ...['core', 'applicator', 'validation', 'meta-data', 'format', 'content']
    .map((name) => `https://json-schema.org/draft/2019-09/vocab/${name}`),
  ...['core', 'applicator', 'unevaluated', 'validation', 'meta-data', 'format-annotation', 'format-assertion', 'content']
    .map((name) => `https://json-schema.org/draft/2020-12/vocab/${name}`),
]);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function schemaFingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('base64url');
}

/** Context consistency only: the dispatcher must still match a server-issued reference and recheck access. */
export function createIntegrationSchemaRef(input: {
  context: IntegrationExecutionContext;
  policy: IntegrationPolicy;
  providerRef: string;
  bindingRevision: string;
  toolName: string;
  toolVersion: string | null;
  inputSchema: Schema;
  outputSchema?: Schema;
}): string {
  const { context } = input;
  return `schema:v1:${schemaFingerprint({
    version: 1,
    context: { actorUserId: context.actorUserId, organizationId: context.organizationId ?? null,
      workspaceId: context.workspaceId ?? null, agentId: context.agentId ?? null, policyRevision: context.policyRevision },
    policy: input.policy,
    providerRef: input.providerRef,
    bindingRevision: input.bindingRevision,
    toolName: input.toolName,
    toolVersion: input.toolVersion,
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
  })}`;
}

function assertBoundedJson(value: unknown, kind: 'schema' | 'arguments'): void {
  const code = kind === 'schema' ? 'schema_unsupported' : 'invalid_arguments';
  const fail = () => new IntegrationContractError(code, `${kind === 'schema' ? 'The tool schema' : 'Tool arguments'} must be bounded, ordinary JSON data.`);
  const ancestors = new WeakSet<object>();
  const stack: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const entry = stack.pop()!;
    if (entry.exit && entry.value && typeof entry.value === 'object') {
      ancestors.delete(entry.value);
      continue;
    }
    if (++nodes > INTEGRATION_SCHEMA_LIMITS.nodes || entry.depth > INTEGRATION_SCHEMA_LIMITS.depth) throw fail();
    if (entry.value === null || typeof entry.value === 'string' || typeof entry.value === 'boolean') continue;
    if (typeof entry.value === 'number') { if (!Number.isFinite(entry.value)) throw fail(); continue; }
    if (!entry.value || typeof entry.value !== 'object' || ancestors.has(entry.value)) throw fail();
    const object = entry.value;
    if (!Array.isArray(object) && ![Object.prototype, null].includes(Object.getPrototypeOf(object))) throw fail();
    ancestors.add(object);
    stack.push({ value: object, depth: entry.depth, exit: true });
    const descriptors = Object.getOwnPropertyDescriptors(object);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') throw fail();
      if (Array.isArray(object) && key === 'length') continue;
      const descriptor = descriptors[key];
      if (descriptor.get || descriptor.set || !descriptor.enumerable) throw fail();
      if (Array.isArray(object) && !/^(0|[1-9][0-9]*)$/u.test(key)) throw fail();
      stack.push({ value: descriptor.value, depth: entry.depth + 1 });
    }
    if (Array.isArray(object) && Object.keys(descriptors).length - 1 !== object.length) throw fail();
  }
  const maximum = kind === 'schema' ? INTEGRATION_SCHEMA_LIMITS.schemaBytes : INTEGRATION_SCHEMA_LIMITS.argumentBytes;
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maximum) throw fail();
}

function dialectFor(schema: Schema): Dialect {
  if (typeof schema === 'boolean' || schema.$schema === undefined) return 'draft07';
  if (typeof schema.$schema !== 'string') throw new IntegrationContractError('schema_unsupported', 'The tool schema declares an unsupported JSON Schema dialect.');
  const dialect = DIALECTS[schema.$schema.replace(/#$/u, '')];
  if (!dialect) throw new IntegrationContractError('schema_unsupported', 'The tool schema declares an unsupported JSON Schema dialect.');
  return dialect;
}

/** Only schema positions are inspected; JSON values inside enum/default/const are ordinary data. */
function assertLocalSchemaReferences(root: Schema, dialect: Dialect): void {
  const stack: unknown[] = [root];
  const single = ['additionalProperties', 'unevaluatedProperties', 'propertyNames', 'additionalItems', 'contains', 'unevaluatedItems', 'not', 'if', 'then', 'else', 'contentSchema'];
  const maps = ['properties', 'patternProperties', 'definitions', '$defs', 'dependentSchemas'];
  const arrays = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const schema = value as Record<string, unknown>;
    if ('$async' in schema) throw new IntegrationContractError('schema_unsupported', 'Asynchronous tool schemas are unsupported.');
    if (schema.$vocabulary && typeof schema.$vocabulary === 'object') {
      for (const [vocabulary, required] of Object.entries(schema.$vocabulary)) {
        if (required === true && !SUPPORTED_VOCABULARIES.has(vocabulary)) {
          throw new IntegrationContractError('schema_unsupported', 'The tool schema requires an unsupported validation vocabulary.');
        }
      }
    }
    if (schema.$schema !== undefined && dialectFor(schema) !== dialect) {
      throw new IntegrationContractError('schema_unsupported', 'Mixed JSON Schema dialects are unsupported.');
    }
    for (const key of ['$ref', '$recursiveRef', '$dynamicRef']) {
      if (schema[key] !== undefined && (typeof schema[key] !== 'string' || !schema[key].startsWith('#'))) {
        throw new IntegrationContractError('schema_unsupported', 'Tool schemas must use local references; external schema retrieval is unavailable.');
      }
    }
    for (const key of single) if (schema[key] !== undefined) stack.push(schema[key]);
    for (const key of maps) {
      const entries = schema[key];
      if (entries && typeof entries === 'object' && !Array.isArray(entries)) stack.push(...Object.values(entries));
    }
    for (const key of arrays) if (Array.isArray(schema[key])) stack.push(...schema[key]);
    if (Array.isArray(schema.items)) stack.push(...schema.items); else if (schema.items !== undefined) stack.push(schema.items);
    if (schema.dependencies && typeof schema.dependencies === 'object') {
      stack.push(...Object.values(schema.dependencies).filter((entry) => !Array.isArray(entry)));
    }
  }
}

// This is fixed application code. Provider schema/arguments are structured-cloned
// workerData, never interpolated into executable source. Compilation and regex
// execution cannot block the server event loop, and the worker gets no ENV secrets.
const VALIDATION_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
try {
  const Constructor = require(workerData.module).default;
  const addFormats = require(workerData.formats).default;
  const ajv = new Constructor({
    strictSchema: true, strictTypes: false, strictTuples: false, strictRequired: false,
    allowUnionTypes: true, allErrors: false, validateFormats: true,
    useDefaults: false, coerceTypes: false, removeAdditional: false,
    ownProperties: true, logger: false, inlineRefs: false,
  });
  addFormats(ajv, { mode: 'full' });
  const schema = workerData.schema;
  if (schema && typeof schema === 'object' && schema.$schema) {
    schema.$schema = workerData.dialect === 'draft07' ? 'http://json-schema.org/draft-07/schema#'
      : 'https://json-schema.org/draft/' + (workerData.dialect === 'draft2019' ? '2019-09' : '2020-12') + '/schema';
  }
  const validate = ajv.compile(schema);
  if (validate.$async) throw new Error('Async schema');
  if (workerData.mode === 'schema' || validate(workerData.arguments)) parentPort.postMessage({ ok: true });
  else {
    const issue = (validate.errors || [])[0];
    parentPort.postMessage({ ok: false, code: 'invalid_arguments',
      message: 'Tool arguments do not satisfy the loaded schema' + (issue ? ' (' + issue.keyword + ').' : '.') });
  }
} catch {
  parentPort.postMessage({ ok: false, code: 'schema_unsupported', message: 'The tool schema cannot be safely validated with a supported JSON Schema dialect.' });
}
`;

let activeWorkers = 0;
const waitingWorkers: Array<() => void> = [];

async function acquireWorker(): Promise<() => void> {
  if (activeWorkers >= INTEGRATION_SCHEMA_LIMITS.concurrentWorkers) {
    if (waitingWorkers.length >= INTEGRATION_SCHEMA_LIMITS.queuedWorkers) {
      throw new IntegrationContractError('schema_unsupported', 'Schema validation is busy; retry this integration request.');
    }
    await new Promise<void>((resolve) => waitingWorkers.push(resolve));
  } else activeWorkers += 1;
  return () => {
    const next = waitingWorkers.shift();
    if (next) next(); else activeWorkers -= 1;
  };
}

async function validateInWorker(schema: Schema, mode: 'schema' | 'arguments', argumentsValue?: unknown): Promise<void> {
  const dialect = dialectFor(schema);
  assertLocalSchemaReferences(schema, dialect);
  const release = await acquireWorker();
  try {
    // Resolve the installed runtime dependencies from the application's package,
    // independent of tsx/Next's own module wrappers and worker loader flags.
    const runtimeRequire = createRequire(path.join(process.cwd(), 'package.json'));
    const moduleName = dialect === 'draft07' ? 'ajv' : dialect === 'draft2019' ? 'ajv/dist/2019' : 'ajv/dist/2020';
    const worker = new Worker(VALIDATION_WORKER, {
      eval: true, env: {}, execArgv: [],
      workerData: { schema, mode, arguments: argumentsValue, dialect,
        module: runtimeRequire.resolve(moduleName), formats: runtimeRequire.resolve('ajv-formats') },
      resourceLimits: { maxOldGenerationSizeMb: INTEGRATION_SCHEMA_LIMITS.workerMemoryMb, stackSizeMb: 4 },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: IntegrationContractError) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error); else resolve();
        };
        const timer = setTimeout(() => finish(new IntegrationContractError('schema_unsupported',
          'Schema validation exceeded its processing limit; this tool was not executed.')), INTEGRATION_SCHEMA_LIMITS.workerTimeoutMs);
        worker.once('message', (result: { ok?: boolean; code?: string; message?: string }) => {
          if (result.ok === true) finish();
          else finish(new IntegrationContractError(result.code === 'invalid_arguments' ? 'invalid_arguments' : 'schema_unsupported',
            result.message || 'The tool schema could not be validated.'));
        });
        worker.once('error', () => finish(new IntegrationContractError('schema_unsupported', 'The isolated schema validator is unavailable.')));
        worker.once('exit', () => {
          if (!settled) finish(new IntegrationContractError('schema_unsupported', 'The isolated schema validator stopped before validation completed.'));
        });
      });
    } finally { await worker.terminate(); }
  } catch (error) {
    if (error instanceof IntegrationContractError) throw error;
    throw new IntegrationContractError('schema_unsupported', 'The isolated schema validator is unavailable.');
  } finally { release(); }
}

export async function validateIntegrationSchema(inputSchema: unknown): Promise<void> {
  assertBoundedJson(inputSchema, 'schema');
  if (typeof inputSchema !== 'boolean' && (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema))) {
    throw new IntegrationContractError('schema_unsupported', 'A tool schema must be an object or boolean JSON Schema.');
  }
  await validateInWorker(inputSchema as Schema, 'schema');
}

/** Bound and capture model arguments before any asynchronous provider work. */
export function cloneIntegrationArguments(argumentsValue: unknown): Record<string, unknown> {
  assertBoundedJson(argumentsValue, 'arguments');
  if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
    throw new IntegrationContractError('invalid_arguments', 'Tool arguments must be a JSON object.');
  }
  return structuredClone(argumentsValue) as Record<string, unknown>;
}

export async function validateIntegrationArguments(inputSchema: unknown, argumentsValue: unknown): Promise<void> {
  assertBoundedJson(inputSchema, 'schema');
  assertBoundedJson(argumentsValue, 'arguments');
  if (typeof inputSchema !== 'boolean' && (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema))) {
    throw new IntegrationContractError('schema_unsupported', 'A tool schema must be an object or boolean JSON Schema.');
  }
  await validateInWorker(inputSchema as Schema, 'arguments', argumentsValue);
}
