export function mobileToolCallId(message: Record<string, unknown>): string | null {
  return typeof message.toolCallId === 'string' && message.toolCallId.trim()
    ? message.toolCallId.trim().slice(0, 200)
    : null;
}
