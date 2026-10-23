/** Test-only data contracts. These values grant no application authority. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { OwnedYjsReceipt } from './owned-yjs-authority-qa';
import { ownedNativeFileRoomReceiptIdentity } from './owned-yjs-native-delete-links-room-target';

export const copyFaultSpec = 'tests/workspace-operation-native-copy.spec.ts';
export type OwnedCopyB2FaultInput = Readonly<{
  version: 1; action: 'arm' | 'cleanup'; faultId: string;
  target: Readonly<{ nonce: string; repo: string; head: string; sourceFingerprint: string;
    buildFingerprint: string; buildId: string; receiptIdentity: string }>;
  sourceWorkspaceId: string; destinationWorkspaceId: string; actorUserId: string;
  sourcePath: string; destinationPath: string; sourceDocumentId: string; sourceGeneration: number;
  planId: string; operationId: string;
}>;
function data(input: unknown, keys: readonly string[]): Record<string, unknown> {
  assert(input && typeof input === 'object' && Object.getPrototypeOf(input) === Object.prototype);
  assert.equal(Reflect.ownKeys(input).length, keys.length); const value: Record<string, unknown> = {};
  for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(input, key);
    assert(descriptor?.enumerable && Object.hasOwn(descriptor, 'value')); value[key] = descriptor.value; }
  return value;
}
function text(value: unknown, maximum = 256): string {
  assert(typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value));
  assert.equal(Buffer.from(value).toString('utf8'), value); return value;
}
export function captureOwnedCopyB2FaultInput(input: unknown): OwnedCopyB2FaultInput {
  const body = data(input, ['version', 'action', 'faultId', 'target', 'sourceWorkspaceId', 'destinationWorkspaceId',
    'actorUserId', 'sourcePath', 'destinationPath', 'sourceDocumentId', 'sourceGeneration', 'planId', 'operationId']);
  assert.equal(body.version, 1); assert(body.action === 'arm' || body.action === 'cleanup');
  const target = data(body.target, ['nonce', 'repo', 'head', 'sourceFingerprint', 'buildFingerprint', 'buildId', 'receiptIdentity']);
  const captured: OwnedCopyB2FaultInput = { version: 1 as const, action: body.action, faultId: text(body.faultId, 32),
    target: Object.freeze({ nonce: text(target.nonce, 32), repo: text(target.repo, 4096), head: text(target.head, 40),
      sourceFingerprint: text(target.sourceFingerprint, 64), buildFingerprint: text(target.buildFingerprint, 64),
      buildId: text(target.buildId), receiptIdentity: text(target.receiptIdentity, 64) }),
    sourceWorkspaceId: text(body.sourceWorkspaceId), destinationWorkspaceId: text(body.destinationWorkspaceId), actorUserId: text(body.actorUserId),
    sourcePath: text(body.sourcePath), destinationPath: text(body.destinationPath), sourceDocumentId: text(body.sourceDocumentId),
    sourceGeneration: body.sourceGeneration as number, planId: text(body.planId, 64), operationId: text(body.operationId, 64) };
  assert.match(captured.faultId, /^[a-f0-9]{32}$/u); assert.match(captured.target.nonce, /^[a-f0-9]{32}$/u);
  assert.match(captured.target.head, /^[a-f0-9]{40}$/u); assert(path.isAbsolute(captured.target.repo));
  for (const pin of [captured.target.sourceFingerprint, captured.target.buildFingerprint, captured.target.receiptIdentity, captured.planId, captured.operationId]) assert.match(pin, /^[a-f0-9]{64}$/u);
  for (const id of [captured.sourceWorkspaceId, captured.destinationWorkspaceId, captured.actorUserId, captured.sourceDocumentId]) assert.match(id, /^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/u);
  assert.notEqual(captured.sourceWorkspaceId, captured.destinationWorkspaceId);
  assert.match(captured.sourcePath, /^owned-yjs-restart-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.md$/u);
  assert.equal(captured.destinationPath, captured.sourcePath, 'Only a root-to-root cross-workspace Copy is a fault target.');
  assert(Number.isSafeInteger(captured.sourceGeneration) && captured.sourceGeneration > 0 && captured.sourceGeneration < Number.MAX_SAFE_INTEGER);
  const operationId = createHash('sha256').update(JSON.stringify(['workspace-file-operation-v1', captured.actorUserId,
    captured.sourceWorkspaceId, captured.destinationWorkspaceId, captured.planId])).digest('hex');
  assert.equal(captured.operationId, operationId);
  return Object.freeze(captured);
}
export function assertOwnedCopyB2FaultBinding(input: OwnedCopyB2FaultInput, receipt: OwnedYjsReceipt): void {
  assert.equal(receipt.activeSpec, copyFaultSpec); assert.equal(receipt.phase, 'browser'); assert.equal(receipt.uncertain, false);
  for (const key of ['nonce', 'repo', 'head', 'sourceFingerprint', 'buildFingerprint', 'buildId'] as const) assert.equal(input.target[key], receipt[key]);
  assert.equal(input.target.receiptIdentity, ownedNativeFileRoomReceiptIdentity(receipt));
  assert.equal(input.actorUserId, receipt.actorId);
}
export function ownedCopyB2FaultDefinition(input: OwnedCopyB2FaultInput) {
  const prefix = `cn_cp_b2_${input.target.nonce.slice(0, 8)}_${input.faultId}`;
  const names = Object.freeze({ sequence: `${prefix}_s`, function: `${prefix}_f`, trigger: `${prefix}_t` });
  for (const value of Object.values(names)) assert(value.length <= 63 && /^[a-z0-9_]+$/u.test(value));
  const marker = createHash('sha256').update(JSON.stringify({ ...input, action: 'owned-copy-b2-insert-once-v1' })).digest('hex');
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const body = `BEGIN
  IF NEW.workspace_id = ${literal(input.destinationWorkspaceId)} AND NEW.path = ${literal(input.destinationPath)}
    AND EXISTS (SELECT 1 FROM public.collaboration_native_copy_receipts
      WHERE operation_id=${literal(input.operationId)} AND workspace_id=${literal(input.destinationWorkspaceId)} AND publication_status='native_committed') THEN
    IF pg_catalog.nextval('public.${names.sequence}'::pg_catalog.regclass) = 1 THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='OWNED_QA_COPY_B2_INSERT_ONCE';
    END IF;
  END IF;
  RETURN NEW;
END;`;
  const create = [
    `CREATE SEQUENCE public."${names.sequence}" AS bigint START WITH 1 INCREMENT BY 1 MINVALUE 1 NO CYCLE CACHE 1`,
    `CREATE FUNCTION public."${names.function}"() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $copy_b2$${body}$copy_b2$`,
    `CREATE TRIGGER "${names.trigger}" BEFORE INSERT ON public.workspace_file_metadata FOR EACH ROW EXECUTE FUNCTION public."${names.function}"()`,
    `COMMENT ON SEQUENCE public."${names.sequence}" IS '${marker}'`,
    `COMMENT ON FUNCTION public."${names.function}"() IS '${marker}'`,
    `COMMENT ON TRIGGER "${names.trigger}" ON public.workspace_file_metadata IS '${marker}'`,
  ];
  return Object.freeze({ names, marker, body, bodySha256: createHash('sha256').update(body).digest('hex'), create: Object.freeze(create) });
}
