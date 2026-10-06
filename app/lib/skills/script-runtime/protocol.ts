import type { Readable, Writable } from 'node:stream';

export const SKILL_SCRIPT_FRAME_LIMIT = 64 * 1024;
export const SKILL_SCRIPT_BRIDGE_LIMIT = 1024 * 1024;

export class SkillScriptProtocolError extends Error {
  readonly code = 'SCRIPT_PROTOCOL_INVALID';
  constructor(message = 'The script tool bridge protocol is invalid.') {
    super(message);
    this.name = 'SkillScriptProtocolError';
  }
}

export function encodeSkillScriptFrame(value: unknown): Buffer {
  const json = JSON.stringify(value);
  if (json === undefined) throw new SkillScriptProtocolError();
  const bytes = Buffer.from(json, 'utf8');
  if (!bytes.length || bytes.length > SKILL_SCRIPT_FRAME_LIMIT) throw new SkillScriptProtocolError('The script bridge frame exceeds its limit.');
  const frame = Buffer.allocUnsafe(4 + bytes.length);
  frame.writeUInt32BE(bytes.length, 0);
  bytes.copy(frame, 4);
  return frame;
}

function requestId(value: unknown, previous: number): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SkillScriptProtocolError();
  const request = value as Record<string, unknown>;
  if (request.version !== 1 || !Number.isSafeInteger(request.id) || request.id !== previous + 1
    || (request.action !== 'describe' && request.action !== 'call') || typeof request.alias !== 'string'
    || !request.alias.length || request.alias.length > 128) throw new SkillScriptProtocolError();
  return request.id as number;
}

/** One run owns these two descriptors. No sockets, handles or actor identities are accepted in RPC. */
export function attachSkillScriptBridge(input: {
  requests: Readable;
  responses: Writable;
  onRequest: (raw: unknown) => Promise<unknown>;
  terminate: (reason: Error) => void;
}): { close: () => void; drain: () => Promise<void>; readonly failure: Error | null; readonly inFlight: boolean } {
  let pending = Buffer.alloc(0), total = 0, previous = 0, busy = false, closed = false;
  let failure: Error | null = null;
  let task: Promise<void> = Promise.resolve();
  const fail = (error: unknown) => {
    if (closed) return;
    failure = error instanceof Error ? error : new SkillScriptProtocolError();
    closed = true;
    input.terminate(failure);
  };
  const onData = (chunk: Buffer) => {
    if (closed) return;
    total += chunk.length;
    if (total > SKILL_SCRIPT_BRIDGE_LIMIT || pending.length + chunk.length > SKILL_SCRIPT_FRAME_LIMIT + 4) {
      fail(new SkillScriptProtocolError('The script bridge exceeds its byte limit.')); return;
    }
    pending = Buffer.concat([pending, chunk]);
    if (pending.length < 4) return;
    const size = pending.readUInt32BE(0);
    if (!size || size > SKILL_SCRIPT_FRAME_LIMIT) { fail(new SkillScriptProtocolError()); return; }
    if (pending.length < 4 + size) return;
    if (busy || pending.length !== 4 + size) { fail(new SkillScriptProtocolError('Only one script bridge request may be in flight.')); return; }
    let raw: unknown, id: number;
    try {
      raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pending.subarray(4)));
      id = requestId(raw, previous);
    } catch (error) { fail(error); return; }
    pending = Buffer.alloc(0); previous = id; busy = true;
    task = (async () => {
      try {
        const response = await input.onRequest(raw);
        if (closed) return;
        if (!response || typeof response !== 'object' || Array.isArray(response)
          || (response as Record<string, unknown>).version !== 1 || (response as Record<string, unknown>).id !== id
          || typeof (response as Record<string, unknown>).ok !== 'boolean') throw new SkillScriptProtocolError();
        const frame = encodeSkillScriptFrame(response);
        total += frame.length;
        if (total > SKILL_SCRIPT_BRIDGE_LIMIT) throw new SkillScriptProtocolError('The script bridge exceeds its byte limit.');
        await new Promise<void>((resolve, reject) => input.responses.write(frame, error => error ? reject(error) : resolve()));
        busy = false;
        if ((response as Record<string, unknown>).terminate === true) fail(new SkillScriptProtocolError('The script tool bridge stopped this run.'));
      } catch (error) { fail(error); }
    })();
  };
  const onEnd = () => { if (pending.length) fail(new SkillScriptProtocolError('The script bridge ended with an incomplete frame.')); };
  input.requests.on('data', onData);
  input.requests.on('end', onEnd);
  input.requests.on('error', fail);
  input.responses.on('error', fail);
  return {
    close: () => {
      closed = true;
      input.requests.off('data', onData); input.requests.off('end', onEnd); input.requests.off('error', fail);
      input.responses.off('error', fail);
    },
    drain: () => task,
    get failure() { return failure; },
    get inFlight() { return busy; },
  };
}
