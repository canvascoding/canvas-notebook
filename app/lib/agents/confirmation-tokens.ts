import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';

const CONFIRMATION_TTL_MS = 10 * 60_000;

type ConfirmationPayload = {
  operation: 'delete_agent';
  agentId: string;
  actorUserId: string;
  revision: number;
  expiresAt: number;
};

function secret(): string {
  return process.env.AUTH_SECRET || process.env.BETTER_AUTH_SECRET || 'canvas-agent-confirmation-development-secret';
}

function signature(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function createAgentDeleteConfirmationToken(input: Omit<ConfirmationPayload, 'operation' | 'expiresAt'>): string {
  const payload: ConfirmationPayload = {
    operation: 'delete_agent',
    ...input,
    expiresAt: Date.now() + CONFIRMATION_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${signature(encoded)}`;
}

export function verifyAgentDeleteConfirmationToken(
  token: string,
  expected: Omit<ConfirmationPayload, 'operation' | 'expiresAt'>,
): void {
  const [encoded, receivedSignature, ...extra] = token.split('.');
  if (!encoded || !receivedSignature || extra.length > 0) throw new Error('Agent delete confirmation is invalid.');
  const expectedSignature = signature(encoded);
  const receivedBuffer = Buffer.from(receivedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (receivedBuffer.length !== expectedBuffer.length || !timingSafeEqual(receivedBuffer, expectedBuffer)) {
    throw new Error('Agent delete confirmation is invalid.');
  }
  let payload: ConfirmationPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as ConfirmationPayload;
  } catch {
    throw new Error('Agent delete confirmation is invalid.');
  }
  if (
    payload.operation !== 'delete_agent'
    || payload.agentId !== expected.agentId
    || payload.actorUserId !== expected.actorUserId
    || payload.revision !== expected.revision
    || !Number.isSafeInteger(payload.expiresAt)
    || payload.expiresAt < Date.now()
  ) {
    throw new Error('Agent delete confirmation is expired or no longer matches the agent revision.');
  }
}
