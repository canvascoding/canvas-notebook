export type MobileCompactBreakMetadata = {
  attemptId: string;
  kind: 'manual' | 'automatic';
  timestamp: string;
  omittedMessageCount: number;
};

export function projectMobileCompactBreakMetadata(
  value: Record<string, unknown>,
  fallback: { id: number; timestamp: number },
): MobileCompactBreakMetadata {
  const timestamp = typeof value.timestamp === 'string' && !Number.isNaN(new Date(value.timestamp).getTime())
    ? value.timestamp
    : new Date(fallback.timestamp).toISOString();
  const attemptId = typeof value.attemptId === 'string' && value.attemptId.trim()
    ? value.attemptId.trim().slice(0, 200)
    : `legacy-${fallback.id}`;
  const omittedMessageCount = Number.isSafeInteger(value.omittedMessageCount)
    && Number(value.omittedMessageCount) >= 0
    ? Number(value.omittedMessageCount)
    : 0;
  return {
    attemptId,
    kind: value.kind === 'automatic' ? 'automatic' : 'manual',
    timestamp,
    omittedMessageCount,
  };
}
