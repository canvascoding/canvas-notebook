/** Bounded known credential fields, shared by storage migration and portable export. */
const CREDENTIAL_NAMES = new Set([
  'key', 'apikey', 'xapikey', 'accesskey', 'secretaccesskey', 'sessiontoken', 'accesstoken', 'refreshtoken',
  'idtoken', 'bearertoken', 'token', 'password', 'secret', 'clientsecret', 'authorization',
  'credentials', 'credential',
]);
const PURE_REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/u;

export function isMcpCredentialName(name: string): boolean {
  return CREDENTIAL_NAMES.has(name.replace(/^--?/u, '').replace(/[_-]/gu, '').toLowerCase());
}

export function hasMcpCredentialUrl(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return Boolean(url.username || url.password)
    || Array.from(url.searchParams).some(([name, content]) => isMcpCredentialName(name) && Boolean(content) && !PURE_REFERENCE.test(content));
}

function hasLiteralCredentialHeader(value: string): boolean {
  const header = /^([^:]+):\s*(.*)$/u.exec(value);
  return Boolean(header && isMcpCredentialName(header[1]) && !PURE_REFERENCE.test(header[2].replace(/^Bearer\s+/iu, '')));
}

/** Returns whole argument positions; no arbitrary argument content is scanned. */
export function mcpCredentialArgIndices(args: readonly string[]): Set<number> {
  const result = new Set<number>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (PURE_REFERENCE.test(arg)) continue;
    const assignment = /^([^=]+)=(.*)$/u.exec(arg);
    if (assignment && isMcpCredentialName(assignment[1]) && !PURE_REFERENCE.test(assignment[2])) result.add(index);
    if (assignment && hasMcpCredentialUrl(assignment[2])) result.add(index);
    if (/^--?[^=]+$/u.test(arg) && isMcpCredentialName(arg) && args[index + 1] !== undefined
      && !PURE_REFERENCE.test(args[index + 1])) result.add(index + 1);
    if (['-H', '--header', '--headers'].includes(arg) && args[index + 1] !== undefined && hasLiteralCredentialHeader(args[index + 1])) result.add(index + 1);
    if (assignment && ['--header', '--headers'].includes(assignment[1]) && hasLiteralCredentialHeader(assignment[2])) result.add(index);
    if (arg.startsWith('-H') && arg.length > 2 && hasLiteralCredentialHeader(arg.slice(2))) result.add(index);
    if (hasMcpCredentialUrl(arg)) result.add(index);
  }
  return result;
}
