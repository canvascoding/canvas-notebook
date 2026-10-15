import { createHash } from 'node:crypto';
import type { CDPSession, Page } from '@playwright/test';

const MAX_EVENTS = 256;
const MAX_SOCKETS = 16;
const MAX_PAYLOAD_BYTES = 128 * 1024;
const MAX_ENCODED_CHARACTERS = Math.ceil(MAX_PAYLOAD_BYTES / 3) * 4;
const MAX_PARSE_FAILURES = 32;

type Frame = { opcode: number; payloadData: string };
type SocketEvent = { requestId: string; timestamp: number };
type FrameEvent = SocketEvent & { response: Frame };
type ProtocolPrefix = { messageType: number; syncSubtype?: number; syncStatus?: boolean };
type Observation = {
  sequence: number; socket: number; atMs: number; protocolTime: number;
  kind: 'frame' | 'closed' | 'frame_error';
  direction?: 'sent' | 'received'; opcode?: number; byteLength?: number;
  sha256?: string; payloadSkipped?: true; closeCode?: number;
} & Partial<ProtocolPrefix>;
type ParseFailure = { sequence: number; reason: 'payload_encoding' | 'protocol_prefix' | 'close_frame' };
type ObserverIssue = 'session_unavailable' | 'network_enable_failed' | 'event_failed' | 'listener_cleanup_failed' | 'detach_failed';

export type PassiveWebSocketSnapshot = {
  available: boolean; disposed: boolean; events: Observation[]; parseFailures: ParseFailure[];
  droppedEvents: number; droppedSockets: number; oversizedPayloads: number; parseFailureCount: number;
  observerIssues: ObserverIssue[];
};
export type PassiveWebSocketObservation = {
  snapshot: () => PassiveWebSocketSnapshot;
  dispose: () => Promise<void>;
};

// Installed Hocuspocus prefixes: byte-length-prefixed address, type0..10,
// Sync/SyncReply subtype0..2; SyncStatus is exactly uint0/1. Never decode an
// address, auth/stateless/awareness body or Yjs content. This is classification,
// not evidence that Yjs applied, schema validation passed or persistence acked.
function protocolPrefix(bytes: Buffer): ProtocolPrefix {
  let position = 0;
  const uint = () => {
    let value = 0, factor = 1;
    for (let index = 0; index < 5; index++) {
      if (position >= bytes.length) throw new Error('prefix');
      const next = bytes[position++]; value += (next & 127) * factor;
      if (value > 0xffffffff) throw new Error('prefix');
      if (next < 128) return value;
      factor *= 128;
    }
    throw new Error('prefix');
  };
  const addressBytes = uint();
  if (addressBytes > 4096 || position + addressBytes >= bytes.length) throw new Error('prefix');
  position += addressBytes;
  const messageType = uint();
  if (messageType > 10) throw new Error('prefix');
  if (messageType === 0 || messageType === 4) {
    const syncSubtype = uint(), payloadBytes = uint();
    if (syncSubtype > 2 || position + payloadBytes !== bytes.length) throw new Error('prefix');
    return { messageType, syncSubtype };
  }
  if (messageType === 8) {
    const applied = uint();
    if (applied > 1 || position !== bytes.length) throw new Error('prefix');
    return { messageType, syncStatus: applied === 1 };
  }
  return { messageType };
}

/** Optional Chromium-only passive observer. Failures are returned as bounded
 * metadata; dispose never throws over an existing test assertion failure. */
export async function installPassiveWebSocketObservation(page: Page): Promise<PassiveWebSocketObservation> {
  const start = performance.now(), events: Observation[] = [], parseFailures: ParseFailure[] = [];
  const sockets = new Map<string, number>(), observerIssues = new Set<ObserverIssue>();
  let session: CDPSession | undefined, available = false, stopped = false, nextSocket = 1, sequence = 0;
  let droppedEvents = 0, droppedSockets = 0, oversizedPayloads = 0, parseFailureCount = 0;
  let disposing: Promise<void> | undefined;
  const parseFailure = (eventSequence: number, reason: ParseFailure['reason']) => {
    parseFailureCount++;
    if (parseFailures.length < MAX_PARSE_FAILURES) parseFailures.push({ sequence: eventSequence, reason });
  };
  const base = (input: SocketEvent, kind: Observation['kind']): Observation | undefined => {
    if (stopped) return;
    if (events.length >= MAX_EVENTS) { droppedEvents++; return; }
    if (typeof input.requestId !== 'string' || input.requestId.length > 128 || !Number.isFinite(input.timestamp)) {
      observerIssues.add('event_failed'); return;
    }
    let socket = sockets.get(input.requestId);
    if (socket === undefined) {
      if (sockets.size >= MAX_SOCKETS) { droppedSockets++; return; }
      socket = nextSocket++; sockets.set(input.requestId, socket);
    }
    const event = { sequence: ++sequence, socket, kind, atMs: performance.now() - start, protocolTime: input.timestamp };
    events.push(event); return event;
  };
  const frame = (input: FrameEvent, direction: 'sent' | 'received') => {
    try {
      const event = base(input, 'frame'); if (!event) return;
      const { opcode, payloadData } = input.response;
      event.direction = direction;
      if (!Number.isInteger(opcode) || opcode < 0 || opcode > 15 || typeof payloadData !== 'string') {
        observerIssues.add('event_failed'); return;
      }
      event.opcode = opcode;
      event.byteLength = Buffer.byteLength(payloadData, opcode === 1 ? 'utf8' : 'base64');
      if (event.byteLength > MAX_PAYLOAD_BYTES || payloadData.length > MAX_ENCODED_CHARACTERS) {
        oversizedPayloads++; event.payloadSkipped = true; return;
      }
      const bytes = Buffer.from(payloadData, opcode === 1 ? 'utf8' : 'base64');
      if (opcode !== 1 && bytes.toString('base64') !== payloadData) {
        parseFailure(event.sequence, 'payload_encoding'); return;
      }
      event.sha256 = createHash('sha256').update(bytes).digest('hex');
      if (opcode === 8) {
        if (bytes.length === 1) parseFailure(event.sequence, 'close_frame');
        else if (bytes.length >= 2) event.closeCode = bytes.readUInt16BE(0);
      } else if (opcode === 2) {
        try { Object.assign(event, protocolPrefix(bytes)); }
        catch { parseFailure(event.sequence, 'protocol_prefix'); }
      }
    } catch { observerIssues.add('event_failed'); }
  };
  const sent = (input: FrameEvent) => frame(input, 'sent');
  const received = (input: FrameEvent) => frame(input, 'received');
  const closed = (input: SocketEvent) => { try { base(input, 'closed'); } catch { observerIssues.add('event_failed'); } };
  // Deliberately never read/store CDP's errorMessage, URL or handshake headers.
  const frameError = (input: SocketEvent) => { try { base(input, 'frame_error'); } catch { observerIssues.add('event_failed'); } };
  const dispose = () => {
    disposing ??= (async () => {
      stopped = true;
      if (session) {
        try {
          session.off('Network.webSocketFrameSent', sent);
          session.off('Network.webSocketFrameReceived', received);
          session.off('Network.webSocketClosed', closed);
          session.off('Network.webSocketFrameError', frameError);
        } catch { observerIssues.add('listener_cleanup_failed'); }
        try { await session.detach(); } catch { observerIssues.add('detach_failed'); }
      }
      sockets.clear();
    })();
    return disposing;
  };
  const observation: PassiveWebSocketObservation = {
    snapshot: () => ({ available, disposed: stopped, events: events.map(event => ({ ...event })),
      parseFailures: parseFailures.map(failure => ({ ...failure })), droppedEvents, droppedSockets,
      oversizedPayloads, parseFailureCount, observerIssues: [...observerIssues] }),
    dispose,
  };
  try { session = await page.context().newCDPSession(page); }
  catch { observerIssues.add('session_unavailable'); return observation; }
  try {
    session.on('Network.webSocketFrameSent', sent);
    session.on('Network.webSocketFrameReceived', received);
    session.on('Network.webSocketClosed', closed);
    session.on('Network.webSocketFrameError', frameError);
    await session.send('Network.enable'); available = true;
  } catch { observerIssues.add('network_enable_failed'); await dispose(); }
  return observation;
}
