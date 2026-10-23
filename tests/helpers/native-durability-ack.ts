import type { Page, WebSocket } from '@playwright/test';
import * as decoding from 'lib0/decoding';

type Candidate = { stateProof: string; stateVector: string };
type Identity = { documentId: string; lifecycleGeneration: number };
type Snapshot = Identity & Candidate & { sequence: number; channel: number };
const validProof = (value: unknown): value is string => typeof value === 'string'
  && /^yjs-snapshot-sha256-v1:[a-f0-9]{64}$/u.test(value);
const safeSequence = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Test-only causal receipt ledger. Records no auth, content or raw frames.
 * The client sends durability_ack only after its current deletion-inclusive
 * proof matches an authoritative snapshot and unsynced changes reach zero. */
export function createNativeDurabilityAckLedger() {
  const snapshots: Snapshot[] = [], confirmed: Snapshot[] = [];
  let failure: string | null = null;
  return {
    record(channel: number, direction: 'sent' | 'received', payload: string | Buffer) {
      if (failure || typeof payload === 'string') return;
      try {
        const decoder = decoding.createDecoder(payload);
        const address = decoding.readVarString(decoder);
        if (address.length > 4096) throw new Error('address');
        if (decoding.readVarUint(decoder) !== 5) return; // Hocuspocus Stateless.
        if (payload.length > 65_536) throw new Error('budget');
        const message: unknown = JSON.parse(decoding.readVarString(decoder));
        if (decoder.pos !== payload.length || !message || typeof message !== 'object' || Array.isArray(message)) {
          throw new Error('stateless');
        }
        const body = message as Record<string, unknown>;
        const documentId = address.split('\0', 1)[0];
        if (direction === 'received' && (body.type === 'durability_snapshot' || body.type === 'checkpointed')) {
          if (body.documentId !== documentId || !safeSequence(body.lifecycleGeneration) || body.lifecycleGeneration < 1
            || !safeSequence(body.documentSequence) || !validProof(body.stateProof)
            || typeof body.stateVector !== 'string' || !body.stateVector.length || body.stateVector.length > 16_384) {
            throw new Error('snapshot');
          }
          const prior = snapshots.find(item => item.channel === channel && item.documentId === documentId
            && item.lifecycleGeneration === body.lifecycleGeneration && item.sequence === body.documentSequence);
          if (prior && (prior.stateProof !== body.stateProof || prior.stateVector !== body.stateVector)) {
            throw new Error('conflicting snapshot');
          }
          if (snapshots.length >= 256) throw new Error('budget');
          snapshots.push({ channel, documentId, lifecycleGeneration: body.lifecycleGeneration,
            sequence: body.documentSequence, stateProof: body.stateProof, stateVector: body.stateVector });
        } else if (direction === 'sent' && body.type === 'durability_ack') {
          if (body.documentId !== documentId || !safeSequence(body.lifecycleGeneration) || !safeSequence(body.sequence)) {
            throw new Error('ack');
          }
          // A prior unrelated ACK cannot certify a later snapshot. Keep the
          // exact channel, document, generation and sequence binding.
          const snapshot = snapshots.findLast(item => item.channel === channel && item.documentId === body.documentId
            && item.lifecycleGeneration === body.lifecycleGeneration && item.sequence === body.sequence);
          if (snapshot) {
            if (confirmed.length >= 256) throw new Error('budget');
            confirmed.push(snapshot);
          }
        }
      } catch { failure = 'The native durability observation is malformed or exceeds its bound.'; }
    },
    hasAcknowledged(identity: Identity, candidate: Candidate): boolean {
      if (failure) throw new Error(failure);
      return confirmed.some(item => item.documentId === identity.documentId
        && item.lifecycleGeneration === identity.lifecycleGeneration
        && item.stateProof === candidate.stateProof && item.stateVector === candidate.stateVector);
    },
  };
}

/** Observe the real provider's acknowledgement; do not flush/checkpoint it. */
export function observeNativeDurabilityAcknowledgements(page: Page) {
  const ledger = createNativeDurabilityAckLedger();
  const cleanups: Array<() => void> = [];
  let serial = 0, channelBudgetExceeded = false;
  const onSocket = (socket: WebSocket) => {
    if (new URL(socket.url()).pathname !== '/ws/collaboration') return;
    const channel = ++serial;
    if (channel > 16) { channelBudgetExceeded = true; return; }
    const received = ({ payload }: { payload: string | Buffer }) => ledger.record(channel, 'received', payload);
    const sent = ({ payload }: { payload: string | Buffer }) => ledger.record(channel, 'sent', payload);
    socket.on('framereceived', received); socket.on('framesent', sent);
    cleanups.push(() => { socket.off('framereceived', received); socket.off('framesent', sent); });
  };
  page.on('websocket', onSocket);
  return {
    hasAcknowledged(identity: Identity, candidate: Candidate) {
      if (channelBudgetExceeded) throw new Error('The native durability observation exceeded its channel bound.');
      return ledger.hasAcknowledged(identity, candidate);
    },
    dispose() { page.off('websocket', onSocket); for (const cleanup of cleanups.splice(0)) cleanup(); },
  };
}
