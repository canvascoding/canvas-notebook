/** Same SHA-256 bytes as the private gateway fingerprint, in the public v2 hex codec. */
export function sharedMcpAppBindingRevision(value: string): string {
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== value) throw new Error('Invalid MCP app binding fingerprint.');
  return bytes.toString('hex');
}
