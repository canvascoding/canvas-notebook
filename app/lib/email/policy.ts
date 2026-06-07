import 'server-only';

export type EmailPolicy = {
  readFrom: string[];
  sendTo: string[];
};

export function normalizeEmailPolicyList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const normalized = item.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    if (!isValidEmailPolicyEntry(normalized)) continue;
    seen.add(normalized);
    entries.push(normalized);
  }
  return entries;
}

export function isValidEmailPolicyEntry(value: string) {
  if (value.startsWith('*@')) return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value.slice(2));
  if (value.startsWith('@')) return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value.slice(1));
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(value);
}

export function parseEmailAddress(value: string) {
  const match = value.match(/<([^>]+)>/u);
  return (match?.[1] || value).trim().toLowerCase();
}

export function isEmailAddressAllowed(address: string, allowlist: string[]) {
  if (allowlist.length === 0) return true;
  const normalized = parseEmailAddress(address);
  const domain = normalized.split('@')[1] || '';
  return allowlist.some((entry) => {
    if (entry.startsWith('*@')) return domain === entry.slice(2);
    if (entry.startsWith('@')) return domain === entry.slice(1);
    return normalized === entry;
  });
}

export function assertEmailSenderAllowed(from: string, readFrom: unknown) {
  if (!isEmailAddressAllowed(from, normalizeEmailPolicyList(readFrom))) {
    throw new Error(`Email sender is not allowed by read policy: ${parseEmailAddress(from)}`);
  }
}

export function assertEmailRecipientsAllowed(recipients: string[], sendTo: unknown) {
  const allowlist = normalizeEmailPolicyList(sendTo);
  for (const recipient of recipients) {
    if (!isEmailAddressAllowed(recipient, allowlist)) {
      throw new Error(`Email recipient is not allowed by send policy: ${parseEmailAddress(recipient)}`);
    }
  }
}

export function todoNotificationSendPolicyError(recipient: string) {
  return [
    `Todo email notification was not sent because ${parseEmailAddress(recipient)} is not allowed by the email account sendTo policy.`,
    'Add this address or its domain in Settings > Integrations > Email accounts > Allowed recipients.',
  ].join(' ');
}
