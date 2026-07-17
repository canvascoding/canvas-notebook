export const HEARTBEAT_OK_TOKEN = 'HEARTBEAT_OK';

export type HeartbeatResultClassification =
  | { kind: 'ok'; text: string }
  | { kind: 'message'; text: string }
  | { kind: 'empty'; text: '' };

export function classifyHeartbeatResult(text: string): HeartbeatResultClassification {
  const normalizedText = text.trim();

  if (!normalizedText) {
    return { kind: 'empty', text: '' };
  }

  if (normalizedText === HEARTBEAT_OK_TOKEN) {
    return { kind: 'ok', text: normalizedText };
  }

  return { kind: 'message', text: normalizedText };
}
