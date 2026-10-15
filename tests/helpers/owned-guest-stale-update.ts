import { createHash } from 'node:crypto';
import type { BrowserContext, WebSocketRoute } from '@playwright/test';
import * as decoding from 'lib0/decoding';
import * as Y from 'yjs';

type Phase = 'before-http-200' | 'after-http-200';
type Channel = { client: WebSocketRoute; server: WebSocketRoute; clientClosed: boolean; serverClosed: boolean };
type Frame = { bytes: Buffer; original: Buffer; sha256: string; type: number; subtype: number; update: Uint8Array };
type Mutation = { localClient: number; beforeClock: number; afterClock: number; marker: string };
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Holds original client data only. send() is a release attempt, never a delivery receipt. */
export async function installOwnedGuestStaleUpdate(context: BrowserContext) {
  const frames: Frame[] = [];
  const evidence: { accessRevoked: Phase[]; logicalClose: Phase[]; authDenied: Phase[];
    physicalClose: Array<{ phase: Phase; code: number | undefined; clientInitiated: boolean }> } = {
    accessRevoked: [], logicalClose: [], authDenied: [], physicalClose: [],
  };
  let name: string | undefined, bound: Channel | undefined, failure: Error | undefined;
  let mode: 'normal' | 'holding' | 'revoking' | 'released' | 'discarded' = 'normal';
  let bytesHeld = 0, routes = 0, http200 = false, markerSha256: string | undefined;
  const fail = (reason: string) => { failure ??= new Error(`Owned stale update: ${reason}.`); };
  const healthy = () => { if (failure) throw failure; };
  const phase = (): Phase => http200 ? 'after-http-200' : 'before-http-200';
  const record = (events: Phase[]) => {
    if (events.length >= 8) fail('denial event bound exceeded');
    else events.push(phase());
  };
  const header = (message: string | Buffer) => {
    if (typeof message === 'string') return null;
    if (message.length > 262_144) throw new Error('frame bound exceeded');
    const decoder = decoding.createDecoder(message);
    // Bound the address before decoding its UTF-8 contents. Never retain tokens.
    const addressBytes = decoding.readVarUint8Array(decoder);
    if (addressBytes.length > 4096) throw new Error('address bound exceeded');
    return { address: new TextDecoder('utf-8', { fatal: true }).decode(addressBytes),
      type: decoding.readVarUint(decoder), decoder };
  };

  await context.routeWebSocket(url => url.pathname === '/ws/collaboration', client => {
    if (++routes > 16) { fail('route bound exceeded'); void client.close(); return; }
    const server = client.connectToServer();
    const channel: Channel = { client, server, clientClosed: false, serverClosed: false };
    client.onMessage(message => {
      if (name && mode !== 'normal') {
        try {
          const decoded = header(message);
          if (decoded?.address === name && (decoded.type === 0 || decoded.type === 4)) {
            const subtype = decoding.readVarUint(decoded.decoder);
            if (subtype === 1 || subtype === 2) {
              // Keep subsequent sync replies from leaking the same held edit.
              if (mode === 'discarded' || mode === 'released' || failure) return;
              if (bound && bound !== channel) throw new Error('document route changed while held');
              const update = decoding.readVarUint8Array(decoded.decoder);
              if (decoding.hasContent(decoded.decoder)) throw new Error('trailing sync bytes');
              if (frames.length >= 16 || bytesHeld + message.length > 262_144) throw new Error('held data bound exceeded');
              bound = channel;
              const bytes = Buffer.from(message);
              frames.push({ bytes, original: Buffer.from(message), sha256: sha256(bytes), type: decoded.type, subtype, update: Buffer.from(update) });
              bytesHeld += bytes.length;
              return;
            }
          }
        } catch { fail('client data could not be inspected'); return; }
      }
      server.send(message);
    });
    server.onMessage(message => {
      if (bound === channel && (mode === 'revoking' || mode === 'released')) {
        try {
          const decoded = header(message);
          if (decoded && decoded.address === name) {
            if (decoded.type === 5) {
              const body: unknown = JSON.parse(decoding.readVarString(decoded.decoder));
              if (decoding.hasContent(decoded.decoder)) throw new Error('trailing stateless bytes');
              if (body && typeof body === 'object' && Reflect.get(body, 'type') === 'access_revoked') record(evidence.accessRevoked);
            } else if (decoded.type === 7) {
              const reason = decoding.readVarString(decoded.decoder);
              if (decoding.hasContent(decoded.decoder)) throw new Error('trailing logical close bytes');
              if (reason === 'Collaboration access revoked') record(evidence.logicalClose);
            } else if (decoded.type === 2 && decoding.readVarUint(decoded.decoder) === 1) record(evidence.authDenied);
          }
        } catch { fail('server evidence could not be inspected'); }
      }
      client.send(message);
    });
    // onClose replaces Playwright's default forwarding: preserve both directions.
    client.onClose((code, reason) => {
      channel.clientClosed = true;
      if (!channel.serverClosed) {
        const allowedCode = code === 1000 || code !== undefined && code >= 3000 && code <= 4999 ? code : undefined;
        void server.close({ code: allowedCode, reason }).catch(() => fail('client close forwarding failed'));
      }
    });
    server.onClose((code, reason) => {
      channel.serverClosed = true;
      if (bound === channel && (mode === 'revoking' || mode === 'released')) {
        if (evidence.physicalClose.length >= 8) fail('physical close event bound exceeded');
        else evidence.physicalClose.push({ phase: phase(), code, clientInitiated: channel.clientClosed });
      }
      if (!channel.clientClosed) void client.close({ code, reason }).catch(() => fail('server close forwarding failed'));
    });
  });

  return {
    arm(documentName: string) {
      healthy();
      if (mode !== 'normal' || !documentName || Buffer.byteLength(documentName) > 4096) throw new Error('Owned stale update: invalid arm.');
      // Exact ordinary session.documentName; no synthetic routing suffix/name.
      name = documentName; mode = 'holding';
    },
    mutation(input: Mutation) {
      healthy();
      if (mode !== 'holding') throw new Error('Owned stale update: mutation inspected out of order.');
      const ranges: Array<{ start: number; end: number }> = [];
      const matching: Frame[] = [];
      for (const frame of frames) {
        if (frame.type !== 0 || frame.subtype !== 2) continue; // A handshake/reply never proves the edit.
        const decoded = Y.decodeUpdate(frame.update);
        if (decoded.structs.length > 16_384) throw new Error('Owned stale update: struct bound exceeded.');
        let hasMarker = false;
        for (const struct of decoded.structs) {
          if (struct.id.client !== input.localClient) continue;
          const start = struct.id.clock, end = start + struct.length;
          if (start >= input.beforeClock && end <= input.afterClock) ranges.push({ start, end });
          if (start >= input.beforeClock && end <= input.afterClock && struct instanceof Y.Item
            && struct.content instanceof Y.ContentString && struct.content.str.includes(input.marker)) hasMarker = true;
        }
        if (hasMarker) matching.push(frame);
      }
      if (matching.length === 0) return null;
      if (matching.length !== 1 || input.afterClock <= input.beforeClock) throw new Error('Owned stale update: ambiguous mutation.');
      let covered = input.beforeClock;
      for (const range of ranges.sort((left, right) => left.start - right.start)) {
        if (range.start > covered) return null;
        covered = Math.max(covered, range.end);
      }
      if (covered !== input.afterClock) return null;
      markerSha256 = matching[0].sha256;
      return { frames: frames.length, updateFrames: frames.filter(frame => frame.type === 0 && frame.subtype === 2).length,
        markerFrameSha256: markerSha256, markerFrameBytes: matching[0].bytes.length,
        localClient: input.localClient, beforeClock: input.beforeClock, afterClock: input.afterClock };
    },
    beginRevoke() {
      healthy();
      if (mode !== 'holding' || !markerSha256 || !bound) throw new Error('Owned stale update: no proven held mutation.');
      mode = 'revoking';
    },
    releaseAfterRevoke(status: number) {
      healthy();
      if (mode !== 'revoking' || status !== 200 || !bound || !markerSha256) throw new Error('Owned stale update: revoke was not confirmed.');
      http200 = true;
      const serverAlreadyClosed = bound.serverClosed;
      const documentAlreadyClosed = evidence.logicalClose.length > 0;
      mode = 'released';
      for (const frame of frames) {
        if (!frame.bytes.equals(frame.original) || sha256(frame.bytes) !== frame.sha256) throw new Error('Owned stale update: original bytes changed.');
        // Playwright swallows send errors. This claims only one attempt on the
        // original route, including when the real server has already closed it.
        bound.server.send(frame.bytes);
        if (!frame.bytes.equals(frame.original) || sha256(frame.bytes) !== frame.sha256) throw new Error('Owned stale update: release changed original bytes.');
      }
      return { originalFrameAttempts: frames.length, markerFrameAttempts: 1,
        markerFrameSha256: markerSha256, serverAlreadyClosed, documentAlreadyClosed,
        sendIsDeliveryReceipt: false as const };
    },
    evidence() { healthy(); return structuredClone(evidence); },
    discard() {
      mode = 'discarded';
      // Error cleanup never publishes held edits. Context.close owns transport cleanup.
      for (const frame of frames) { frame.bytes.fill(0); frame.original.fill(0); frame.update.fill(0); }
      frames.length = 0;
    },
  };
}
