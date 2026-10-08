/** Shared, browser-safe mailbox parsing. Only addresses observed in headers are returned. */
export type EmailAddress = { address: string; name?: string };

function mailboxParts(value: string): string[] {
  const parts: string[] = [];
  let part = '';
  let quoted = false;
  let escaped = false;
  let angle = false;
  let commentDepth = 0;
  for (const char of value.slice(0, 16_384)) {
    if (escaped) { part += char; escaped = false; continue; }
    if (char === '\\' && (quoted || commentDepth)) { part += char; escaped = true; continue; }
    if (!quoted && char === '(') commentDepth++;
    if (!quoted && char === ')' && commentDepth) commentDepth--;
    if (char === '"' && !commentDepth) quoted = !quoted;
    if (!quoted && !commentDepth && char === '<') angle = true;
    if (!quoted && !commentDepth && char === '>') angle = false;
    if (!quoted && !angle && !commentDepth && char === ':' && !part.includes('@')) { part = ''; continue; }
    if (!quoted && !angle && !commentDepth && /[,;\n]/u.test(char)) { parts.push(part); part = ''; }
    else part += char;
  }
  parts.push(part);
  return parts.slice(0, 100);
}

function uncommentMailbox(value: string): { text: string; comment: string } {
  let text = '';
  let comment = '';
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const char of value) {
    if (escaped) { if (depth) comment += char; else text += char; escaped = false; continue; }
    if (char === '\\' && (quoted || depth)) { if (!depth) text += char; escaped = true; continue; }
    if (char === '"' && !depth) quoted = !quoted;
    if (!quoted && char === '(') { depth++; continue; }
    if (!quoted && char === ')' && depth) { depth--; if (!depth) comment += ' '; continue; }
    if (depth) comment += char;
    else text += char;
  }
  return { text: text.trim(), comment: comment.trim() };
}

function addressEntry(address: unknown, name?: unknown): EmailAddress | null {
  if (typeof address !== 'string' || /[\u0000-\u001f\u007f]/u.test(address)) return null;
  const normalized = address.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[^\s@<>"(),;:]+$/u.test(normalized)) return null;
  const displayName = typeof name === 'string'
    ? name.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 120)
    : '';
  return { address: normalized, ...(displayName ? { name: displayName } : {}) };
}

export function parseEmailAddresses(value: unknown): EmailAddress[] {
  const entries: EmailAddress[] = [];
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 100)) entries.push(...parseEmailAddresses(item));
  } else if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>;
    if (item.emailAddress && typeof item.emailAddress === 'object') return parseEmailAddresses(item.emailAddress);
    if (Array.isArray(item.value)) return parseEmailAddresses(item.value);
    const entry = addressEntry(item.address || item.email, item.name || item.displayName);
    if (entry) entries.push(entry);
  } else if (typeof value === 'string') {
    if (/[\u0000-\u001f\u007f]/u.test(value)) return [];
    for (const part of mailboxParts(value)) {
      const cleaned = uncommentMailbox(part);
      const bracketed = cleaned.text.match(/^\s*(.*?)\s*<([^<>]+)>\s*$/u);
      let name = bracketed?.[1]?.trim() || cleaned.comment;
      if (name?.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).replace(/\\(["\\])/gu, '$1');
      const entry = addressEntry(bracketed?.[2] || cleaned.text, name);
      if (entry) entries.push(entry);
    }
  }
  const unique = new Map<string, EmailAddress>();
  for (const entry of entries) {
    const previous = unique.get(entry.address);
    if (!previous || !previous.name && entry.name) unique.set(entry.address, entry);
  }
  return [...unique.values()].slice(0, 100);
}

export function formatEmailAddresses(value: unknown): string[] {
  return parseEmailAddresses(value).map(({ address, name }) => {
    if (!name) return address;
    const label = /[",;<>\\]/u.test(name) ? JSON.stringify(name) : name;
    return `${label} <${address}>`;
  });
}

export function formatEmailAddress(value: unknown): string {
  return formatEmailAddresses(value)[0] || '';
}

export function emailReplyRecipients(
  message: { from?: unknown; to?: unknown; cc?: unknown; replyTo?: unknown },
  mode: 'reply' | 'reply-all' | 'forward',
  ownAddresses: Iterable<string>,
): { to: string[]; cc: string[] } {
  if (mode === 'forward') return { to: [], cc: [] };
  const own = new Set(parseEmailAddresses([...ownAddresses]).map(item => item.address));
  const seen = new Set(own);
  const take = (value: unknown) => parseEmailAddresses(value).flatMap(({ address }) => {
    if (seen.has(address)) return [];
    seen.add(address);
    return [address];
  });
  const replyTo = parseEmailAddresses(message.replyTo);
  const from = parseEmailAddresses(message.from);
  const target = replyTo.length ? replyTo : from;
  const to = take(target);
  // Replying to a sent message addresses its recipients rather than the user's own address.
  if (!to.length && from.some(item => own.has(item.address))) to.push(...take(message.to));
  else if (!to.length && replyTo.length) to.push(...take(from));
  if (mode === 'reply-all') to.push(...take(message.to));
  const cc = mode === 'reply-all' ? take(message.cc) : [];
  return { to, cc };
}
