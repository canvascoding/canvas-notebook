import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CollaborationCheckpointValidationError,
  COLLABORATION_CHECKPOINT_ERROR_CODES as CODES,
  type RichMarkdownCheckpointValidationCode,
} from '../app/lib/collaboration/checkpoint-errors';
import {
  classifyCollaborationProjectionError,
  inCollaborationProjectionPhase,
  type CollaborationProjectionPhase,
} from '../app/lib/collaboration/projection-errors';

const importCodes = [
  'MARKDOWN_IMPORT_INVALID_INPUT', 'MARKDOWN_IMPORT_ENCODING_UNSUPPORTED', 'MARKDOWN_IMPORT_RICH_UNAVAILABLE',
  'MARKDOWN_IMPORT_TARGET_CHANGED', 'MARKDOWN_IMPORT_TARGET_NOT_EMPTY', 'MARKDOWN_IMPORT_LIFECYCLE_REQUIRED',
  'MARKDOWN_IMPORT_REQUEST_CONFLICT', 'MARKDOWN_IMPORT_BUSY', 'MARKDOWN_IMPORT_COMMIT_UNCONFIRMED',
] as const;
const principalCodes = [
  'PRINCIPAL_REQUIRED', 'PRINCIPAL_INVALID', 'PRINCIPAL_BUSY', 'PRINCIPAL_SCOPE_CHANGED', 'PRINCIPAL_AUTH_REVOKED',
  'PRINCIPAL_ACCESS_DENIED', 'PRINCIPAL_WORKSPACE_UNCONFIRMED', 'PRINCIPAL_TOO_LARGE', 'PRINCIPAL_DETACHED',
  'PRINCIPAL_REENTRANT', 'PRINCIPAL_SCHEMA_INVALID', 'PRINCIPAL_EXPIRED',
] as const;
const birthCodes = [
  'MARKDOWN_CREATE_BIRTH_ACK_REQUIRED', 'MARKDOWN_CREATE_BIRTH_INVALID_INPUT', 'MARKDOWN_CREATE_BIRTH_MANUAL_PATH_EXISTS',
  'MARKDOWN_CREATE_BIRTH_CLOSED', 'MARKDOWN_CREATE_BIRTH_IO_UNCONFIRMED', 'MARKDOWN_CREATE_BIRTH_NAMESPACE_CHANGED',
  'MARKDOWN_CREATE_BIRTH_OBSERVATION_UNCONFIRMED', 'MARKDOWN_CREATE_BIRTH_RECORD_CHANGED',
  'MARKDOWN_CREATE_BIRTH_RECOVERY_REQUIRED', 'MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED', 'MARKDOWN_CREATE_BIRTH_SOURCE_EXPIRED',
  'MARKDOWN_CREATE_BIRTH_TARGET_CHANGED', 'MARKDOWN_CREATE_BIRTH_UNAWAITED_IO',
] as const;
const nativeCodes = [
  'ENOENT', 'EACCES', 'ENOSPC', 'EIO', 'EROFS', 'EMFILE', 'ETIMEDOUT', 'ECONNRESET',
  '23502', '23503', '23505', '40001', '40P01', '57014', '53300', '08001', '08006', '57P01', '55P03',
] as const;
const phases: readonly CollaborationProjectionPhase[] = [
  'snapshot_validate', 'receipt_begin', 'file_write', 'checkpoint_confirm', 'projection_finalize', 'receipt_finalize',
  'create_observe', 'create_native', 'create_effects', 'publication_authority', 'birth_open', 'birth_prepare', 'birth_publish',
  'birth_observe', 'birth_complete', 'birth_verify', 'birth_finalize',
];
const privatePath = '/private/diagnostic-only/secret-note.md';
const privateSql = 'SELECT secret_body FROM private_notes';
const privateSecret = 'diagnostic-only-token-do-not-emit';
const privateMessage = `${privatePath} ${privateSql} ${privateSecret}`;
type Diagnostic = ReturnType<typeof classifyCollaborationProjectionError>;

function privateError(code: string): Error & { code: string } {
  return Object.assign(new Error(privateMessage), { code, path: privatePath, sql: privateSql, token: privateSecret });
}

function assertSafe(diagnostic: Diagnostic): void {
  assert.deepEqual(Object.keys(diagnostic).sort(), ['blocksEditing', 'causeCode', 'code', 'permanent', 'phase']);
  const output = JSON.stringify(diagnostic);
  for (const secret of [privateMessage, privatePath, privateSql, privateSecret]) {
    assert.equal(output.includes(secret), false, 'The diagnostic must exclude private error fields.');
  }
}

function assertTransient(diagnostic: Diagnostic, causeCode: string, phase: CollaborationProjectionPhase = 'checkpoint_confirm'): void {
  assert.deepEqual(diagnostic, { code: CODES.failed, phase, causeCode, permanent: false, blocksEditing: false });
  assertSafe(diagnostic);
}

test('finite Import, Principal, Birth and lifecycle cause codes retain the existing transient checkpoint contract', () => {
  assert.equal(importCodes.length, 9);
  assert.equal(principalCodes.length, 12);
  assert.equal(birthCodes.length, 13);
  for (const code of [...importCodes, ...principalCodes, ...birthCodes, 'COLLABORATION_FILE_LIFECYCLE_BUSY']) {
    assertTransient(classifyCollaborationProjectionError(privateError(code)), code);
  }
});

test('finite native filesystem, PostgreSQL and transport cause codes remain safe', () => {
  for (const code of nativeCodes) assertTransient(classifyCollaborationProjectionError(privateError(code)), code);
});

test('unknown codes and prefix lookalikes never become diagnostic cause codes', () => {
  for (const code of [
    'TOKEN-PRIVATE', 'MARKDOWN_IMPORT_UNKNOWN', 'PRINCIPAL_UNKNOWN', 'MARKDOWN_CREATE_BIRTH_UNKNOWN',
    'MARKDOWN_CREATE_BIRTH_CLOSURE_FAILED', 'MARKDOWN_CREATE_BIRTH_PARENT_CLOSURE_FAILED',
    'MARKDOWN_CREATE_BIRTH_STORE_CLOSURE_FAILED', 'PRINCIPAL_BUSY ' + privateSecret,
    'MARKDOWN_IMPORT_TARGET_CHANGED/' + privatePath, 'MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED:' + privateSql,
  ]) assertTransient(classifyCollaborationProjectionError(privateError(code)), 'unknown');
  assertTransient(classifyCollaborationProjectionError({ code: { toString: () => privateMessage }, message: privateMessage }), 'unknown');
});

test('every finite projection and create/birth phase survives its actual wrapper', async () => {
  for (const phase of phases) {
    const original = privateError('PRINCIPAL_BUSY');
    await assert.rejects(inCollaborationProjectionPhase(phase, async () => { throw original; }), (error: unknown) => {
      assert.equal(error, original, 'An extensible error must retain its identity.');
      assertTransient(classifyCollaborationProjectionError(error), 'PRINCIPAL_BUSY', phase);
      return true;
    });
  }
});

test('an outer create phase does not replace the original nested birth failure stage', async () => {
  const original = privateError('MARKDOWN_CREATE_BIRTH_TARGET_CHANGED');
  await assert.rejects(inCollaborationProjectionPhase('create_native', () =>
    inCollaborationProjectionPhase('birth_publish', async () => { throw original; })), (error: unknown) => {
    assert.equal(error, original);
    assertTransient(classifyCollaborationProjectionError(error), 'MARKDOWN_CREATE_BIRTH_TARGET_CHANGED', 'birth_publish');
    return true;
  });
});

test('the first finite cause survives later cleanup causes and AggregateError children', async () => {
  const original = privateError('MARKDOWN_IMPORT_TARGET_CHANGED');
  const aggregate = new AggregateError([original, privateError('EIO')], privateMessage);
  await assert.rejects(inCollaborationProjectionPhase('publication_authority', async () => {
    throw new Error(privateMessage, { cause: aggregate });
  }), (error: unknown) => {
    assertTransient(classifyCollaborationProjectionError(error), 'MARKDOWN_IMPORT_TARGET_CHANGED', 'publication_authority');
    return true;
  });
  const direct = Object.assign(new Error(privateMessage, { cause: privateError('EIO') }), { code: 'PRINCIPAL_AUTH_REVOKED' });
  assertTransient(classifyCollaborationProjectionError(direct), 'PRINCIPAL_AUTH_REVOKED');
});

test('a primary nested cause is classified before a later aggregate cleanup cause', async () => {
  const original = privateError('MARKDOWN_IMPORT_TARGET_CHANGED');
  const primary = new Error(privateMessage, { cause: original });
  const aggregate = new AggregateError([primary, privateError('EIO')], privateMessage);
  await assert.rejects(inCollaborationProjectionPhase('publication_authority', async () => {
    throw aggregate;
  }), (error: unknown) => {
    assertTransient(classifyCollaborationProjectionError(error), 'MARKDOWN_IMPORT_TARGET_CHANGED', 'publication_authority');
    return true;
  });
});

test('a primary aggregate failure phase survives a later cleanup failure phase', async () => {
  const original = Object.assign(privateError('MARKDOWN_CREATE_BIRTH_TARGET_CHANGED'), { collaborationPhase: 'birth_publish' });
  const cleanup = Object.assign(privateError('ENOENT'), { collaborationPhase: 'birth_verify' });
  const aggregate = new AggregateError([original, cleanup], privateMessage);
  await assert.rejects(inCollaborationProjectionPhase('create_native', async () => {
    throw aggregate;
  }), (error: unknown) => {
    assertTransient(classifyCollaborationProjectionError(error), 'MARKDOWN_CREATE_BIRTH_TARGET_CHANGED', 'birth_publish');
    return true;
  });
});

test('an unknown primary cause retains its finite phase before a typed cleanup failure', async () => {
  const original = Object.assign(privateError('UNKNOWN'), { collaborationPhase: 'snapshot_validate' });
  const cleanup = Object.assign(privateError('EIO'), { collaborationPhase: 'birth_verify' });
  await assert.rejects(inCollaborationProjectionPhase('create_native', async () => {
    throw new AggregateError([original, cleanup], privateMessage);
  }), (error: unknown) => {
    assertTransient(classifyCollaborationProjectionError(error), 'unknown', 'snapshot_validate');
    return true;
  });
});

test('mixed checkpoint AggregateError codes retain the original breadth-first permanent decisions', () => {
  for (const [primaryCode, cleanupCode, permanent] of [
    [CODES.failed, CODES.schemaInvalid, false],
    [CODES.schemaInvalid, CODES.failed, true],
  ] as const) {
    const primary = new Error(privateMessage, { cause: privateError(primaryCode) });
    const aggregate = new AggregateError([primary, privateError(cleanupCode)], privateMessage);
    const diagnostic = classifyCollaborationProjectionError(aggregate);
    assert.deepEqual(diagnostic, { code: primaryCode, phase: 'checkpoint_confirm', causeCode: 'unknown', permanent, blocksEditing: permanent });
    assertSafe(diagnostic);
  }
});

test('an existing inner failure phase survives a causal and aggregate wrapper', async () => {
  const original = Object.assign(privateError('55P03'), { collaborationPhase: 'birth_verify' });
  await assert.rejects(inCollaborationProjectionPhase('create_effects', async () => {
    throw new AggregateError([new Error(privateMessage, { cause: original })], privateMessage);
  }), (error: unknown) => {
    assertTransient(classifyCollaborationProjectionError(error), '55P03', 'birth_verify');
    return true;
  });
});

test('frozen errors are wrapped without losing finite cause or original phase', async () => {
  for (const existingPhase of [undefined, 'birth_prepare'] as const) {
    const original = privateError('MARKDOWN_CREATE_BIRTH_IO_UNCONFIRMED');
    if (existingPhase) Object.assign(original, { collaborationPhase: existingPhase });
    Object.freeze(original);
    await assert.rejects(inCollaborationProjectionPhase('create_native', async () => { throw original; }), (error: unknown) => {
      assert(error instanceof Error);
      assert.notEqual(error, original);
      assert.equal(error.cause, original);
      assertTransient(classifyCollaborationProjectionError(error), 'MARKDOWN_CREATE_BIRTH_IO_UNCONFIRMED', existingPhase ?? 'create_native');
      return true;
    });
  }
});

test('primitive throws retain the finite wrapper phase and expose no primitive content', async () => {
  for (const original of [undefined, null, false, 0, privateMessage, Symbol(privateSecret)]) {
    await assert.rejects(inCollaborationProjectionPhase('birth_observe', async () => { throw original; }), (error: unknown) => {
      assert(error instanceof Error);
      assert.equal(error.cause, original);
      assertTransient(classifyCollaborationProjectionError(error), 'unknown', 'birth_observe');
      return true;
    });
  }
});

test('validation errors keep their specific code, cause and existing editing-block contract', async () => {
  const validations: ReadonlyArray<readonly [RichMarkdownCheckpointValidationCode, string, boolean]> = [
    ['schema_invalid', CODES.schemaInvalid, true], ['stable_id_missing', CODES.stableIdMissing, true],
    ['stable_id_duplicate', CODES.stableIdDuplicate, true], ['roundtrip_unstable', CODES.roundtripUnstable, false],
    ['serialization_failed', CODES.serializationFailed, false],
  ];
  for (const [validationCode, code, permanent] of validations) {
    const original = new CollaborationCheckpointValidationError(validationCode);
    await assert.rejects(inCollaborationProjectionPhase('snapshot_validate', async () => {
      throw new AggregateError([privateError('EIO'), original], privateMessage);
    }), (error: unknown) => {
      const diagnostic = classifyCollaborationProjectionError(error);
      assert.deepEqual(diagnostic, { code, phase: 'snapshot_validate', causeCode: validationCode, permanent, blocksEditing: permanent });
      assertSafe(diagnostic);
      return true;
    });
  }
});

test('existing checkpoint codes keep their permanent and editing-block decisions', () => {
  const permanentCodes = new Set<string>([CODES.schemaInvalid, CODES.stableIdMissing, CODES.stableIdDuplicate, CODES.identityMismatch, CODES.quarantined]);
  for (const code of Object.values(CODES)) {
    const diagnostic = classifyCollaborationProjectionError(privateError(code));
    const permanent = permanentCodes.has(code);
    assert.deepEqual(diagnostic, { code, phase: 'checkpoint_confirm', causeCode: 'unknown', permanent, blocksEditing: permanent });
    assertSafe(diagnostic);
  }
});

test('unknown phases and cyclic causes remain bounded and do not expose private data', () => {
  const cyclic = Object.assign(privateError('UNKNOWN'), { collaborationPhase: privatePath, cause: undefined as unknown });
  cyclic.cause = cyclic;
  assertTransient(classifyCollaborationProjectionError(cyclic), 'unknown');
});
