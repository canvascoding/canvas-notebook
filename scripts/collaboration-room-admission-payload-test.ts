import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CollaborationAdmissionError,
  captureCollaborationAdmissionRequest,
  collaborationAdmissionActionDigest,
  type CollaborationAdmissionRequest,
} from '../app/lib/collaboration/room-admission-contract';

const BASE_REQUEST = {
  requestId: 'e9ac591f-330e-46fc-9fae-6cf5c3c98211',
  actorId: 'actor-payload-test',
  action: 'move' as const,
  scopes: [{ workspaceId: 'workspace-payload-test', organizationId: null, path: 'notes', kind: 'subtree' as const }],
  expectedDocuments: [],
};

function request(payloadText: string, action: CollaborationAdmissionRequest['action'] = 'move',
  digest = collaborationAdmissionActionDigest(action, payloadText)) {
  return { ...BASE_REQUEST, action, actionDigest: digest, actionPayloadText: payloadText };
}

function assertInvalid(action: () => unknown) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof CollaborationAdmissionError);
    assert.equal(error.code, 'ADMISSION_INVALID_REQUEST');
    return true;
  });
}

test('canonical-equivalent payloads share action digest and request intent', () => {
  const compact = '{"z":2,"nested":{"b":true,"a":"x"},"a":[1,null]}';
  const spacedAndReordered = '{ "a" : [1, null], "nested" : { "a":"x", "b":true }, "z": 2 }';
  const first = captureCollaborationAdmissionRequest(request(compact));
  const second = captureCollaborationAdmissionRequest(request(spacedAndReordered));

  assert.equal(collaborationAdmissionActionDigest('move', compact), collaborationAdmissionActionDigest('move', spacedAndReordered));
  assert.equal(first.requestDigest, second.requestDigest);
  assert.equal(first.intentText, second.intentText);
  assert.equal(first.request.actionPayloadText, '{"a":[1,null],"nested":{"a":"x","b":true},"z":2}');
  assert.deepEqual(Object.keys(first.request), [
    'requestId', 'actorId', 'action', 'actionDigest', 'scopes', 'expectedDocuments', 'actionPayloadText',
  ]);
});

test('payload capture copies canonical text and binds digest to action and payload', () => {
  const input = request('{"value":1}');
  const captured = captureCollaborationAdmissionRequest(input);
  input.actionPayloadText = '{"value":2}';
  assert.equal(captured.request.actionPayloadText, '{"value":1}');
  assertInvalid(() => captureCollaborationAdmissionRequest(request('{"value":1}', 'move', 'f'.repeat(64))));
  const renameDigest = collaborationAdmissionActionDigest('rename', '{"value":1}');
  assert.notEqual(renameDigest, collaborationAdmissionActionDigest('move', '{"value":1}'));
  assertInvalid(() => captureCollaborationAdmissionRequest(request('{"value":1}', 'move', renameDigest)));
});

test('payload requires valid JSON object root and finite JSON values', () => {
  for (const text of ['{', 'null', '[]', '"string"', '4', 'true', '{"n":1e999}']) {
    assertInvalid(() => collaborationAdmissionActionDigest('move', text));
    assertInvalid(() => captureCollaborationAdmissionRequest({ ...BASE_REQUEST, actionDigest: 'a'.repeat(64), actionPayloadText: text }));
  }
  assertInvalid(() => captureCollaborationAdmissionRequest({ ...BASE_REQUEST, actionDigest: 'a'.repeat(64), actionPayloadText: undefined }));
});

test('payload enforces UTF-8 byte, nesting-depth, and node-count bounds', () => {
  const atByteLimit = JSON.stringify({ value: 'a'.repeat(65_524) });
  assert.equal(Buffer.byteLength(atByteLimit, 'utf8'), 64 * 1024);
  assert.doesNotThrow(() => collaborationAdmissionActionDigest('move', atByteLimit));
  const tooManyBytes = JSON.stringify({ value: 'é'.repeat(33_000) });
  assert.ok(Buffer.byteLength(tooManyBytes, 'utf8') > 64 * 1024);
  assertInvalid(() => collaborationAdmissionActionDigest('move', tooManyBytes));

  let atDepthLimit = '0';
  for (let index = 0; index < 15; index += 1) atDepthLimit = `{"x":${atDepthLimit}}`;
  assert.doesNotThrow(() => collaborationAdmissionActionDigest('move', atDepthLimit));
  const tooDeep = `{"x":${atDepthLimit}}`;
  assertInvalid(() => collaborationAdmissionActionDigest('move', tooDeep));

  const atNodeLimit = JSON.stringify({ values: Array.from({ length: 4094 }, () => 0) });
  assert.doesNotThrow(() => collaborationAdmissionActionDigest('move', atNodeLimit));
  const tooManyNodes = JSON.stringify({ values: Array.from({ length: 4095 }, () => 0) });
  assertInvalid(() => collaborationAdmissionActionDigest('move', tooManyNodes));
});

test('payload rejects prototype-sensitive keys at every depth', () => {
  for (const text of [
    '{"__proto__":{"polluted":true}}',
    '{"nested":{"constructor":{"prototype":{"polluted":true}}}}',
    '{"prototype":null}',
  ]) assertInvalid(() => collaborationAdmissionActionDigest('move', text));
});

test('legacy requests without actionPayloadText retain the prior request shape and digest behavior', () => {
  const legacy = { ...BASE_REQUEST, actionDigest: 'c'.repeat(64) };
  const captured = captureCollaborationAdmissionRequest(legacy);
  assert.equal('actionPayloadText' in captured.request, false);
  assert.equal(captured.request.actionDigest, legacy.actionDigest);
  assert.equal(captured.intentText, JSON.stringify({
    requestId: legacy.requestId,
    actorId: legacy.actorId,
    action: legacy.action,
    actionDigest: legacy.actionDigest,
    scopes: legacy.scopes,
    expectedDocuments: legacy.expectedDocuments,
  }));
});
