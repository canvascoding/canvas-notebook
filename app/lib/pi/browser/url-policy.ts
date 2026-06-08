import 'server-only';

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const DNS_LOOKUP_TIMEOUT_MS = 2_000;

const ALWAYS_BLOCKED_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata',
]);

const REQUEST_SAFE_PROTOCOLS = new Set(['about:', 'blob:', 'data:', 'http:', 'https:']);

export type BrowserUrlPolicyDecision = {
  allowed: boolean;
  url: string;
  reason: string | null;
  hostname: string | null;
  category: string | null;
};

type BrowserUrlPolicyOptions = {
  env?: NodeJS.ProcessEnv;
  lookupDns?: boolean;
  allowRequestSafeProtocols?: boolean;
};

function envFlag(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() || '');
}

function getAllowedHosts(env: NodeJS.ProcessEnv): Set<string> {
  return new Set(
    (env.CANVAS_BROWSER_ALLOWED_HOSTS || '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[(.*)\]$/u, '$1');
}

function parseIpv4(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  const parts = address.split('.').map((part) => Number(part));
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

function classifyIpv4(address: string): { allowed: boolean; category: string; reason?: string } | null {
  const parts = parseIpv4(address);
  if (!parts) return null;
  const [a, b, c, d] = parts;

  if (a === 169 && b === 254 && c === 169 && d === 254) {
    return {
      allowed: false,
      category: 'metadata',
      reason: 'Blocked cloud metadata endpoint.',
    };
  }
  if (a === 127) {
    return { allowed: true, category: 'loopback' };
  }
  if (a === 0) {
    return { allowed: false, category: 'unspecified', reason: 'Blocked unspecified IPv4 range.' };
  }
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
    return { allowed: false, category: 'private', reason: 'Blocked private network address.' };
  }
  if (a === 169 && b === 254) {
    return { allowed: false, category: 'link-local', reason: 'Blocked link-local address.' };
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return { allowed: false, category: 'carrier-grade-nat', reason: 'Blocked shared carrier-grade NAT range.' };
  }
  if (a === 192 && b === 0 && c === 0) {
    return { allowed: false, category: 'reserved', reason: 'Blocked reserved IPv4 range.' };
  }
  if (a === 198 && (b === 18 || b === 19)) {
    return { allowed: false, category: 'benchmark', reason: 'Blocked benchmark IPv4 range.' };
  }
  if (a >= 224 && a <= 239) {
    return { allowed: false, category: 'multicast', reason: 'Blocked multicast address.' };
  }
  if (a >= 240) {
    return { allowed: false, category: 'reserved', reason: 'Blocked reserved IPv4 range.' };
  }

  return { allowed: true, category: 'public' };
}

function isIpv4MappedIpv6(address: string): string | null {
  const normalized = address.toLowerCase();
  const match = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u);
  return match?.[1] || null;
}

function classifyIpAddress(address: string): { allowed: boolean; category: string; reason?: string } | null {
  const mappedIpv4 = isIpv4MappedIpv6(address);
  if (mappedIpv4) {
    return classifyIpv4(mappedIpv4);
  }

  const ipv4 = classifyIpv4(address);
  if (ipv4) return ipv4;

  if (isIP(address) !== 6) {
    return null;
  }

  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return { allowed: true, category: 'loopback' };
  }
  if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') {
    return { allowed: false, category: 'unspecified', reason: 'Blocked unspecified IPv6 address.' };
  }
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
    return { allowed: false, category: 'link-local', reason: 'Blocked IPv6 link-local address.' };
  }
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return { allowed: false, category: 'private', reason: 'Blocked private IPv6 address.' };
  }
  if (normalized.startsWith('ff')) {
    return { allowed: false, category: 'multicast', reason: 'Blocked IPv6 multicast address.' };
  }

  return { allowed: true, category: 'public' };
}

function allowPrivateNetworks(env: NodeJS.ProcessEnv): boolean {
  return envFlag(env.CANVAS_BROWSER_ALLOW_PRIVATE_NETWORKS);
}

function applyPrivateNetworkOverride(
  decision: { allowed: boolean; category: string; reason?: string },
  env: NodeJS.ProcessEnv,
): { allowed: boolean; category: string; reason?: string } {
  if (decision.category === 'metadata') {
    return decision;
  }
  if (!decision.allowed && decision.category === 'private' && allowPrivateNetworks(env)) {
    return { allowed: true, category: 'private-allowed' };
  }
  return decision;
}

async function lookupWithTimeout(hostname: string): Promise<string[]> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      lookup(hostname, { all: true, verbatim: true }).then((entries) => entries.map((entry) => entry.address)),
      new Promise<string[]>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('DNS lookup timed out.')), DNS_LOOKUP_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function decision(url: string, allowed: boolean, reason: string | null, hostname: string | null, category: string | null): BrowserUrlPolicyDecision {
  return { allowed, url, reason, hostname, category };
}

export async function checkBrowserUrlPolicy(
  rawUrl: string,
  options: BrowserUrlPolicyOptions = {},
): Promise<BrowserUrlPolicyDecision> {
  const env = options.env ?? process.env;
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return decision(rawUrl, false, 'URL is empty.', null, null);
  }
  if (trimmed === 'about:blank') {
    return decision(trimmed, true, null, null, 'about');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return decision(trimmed, false, 'URL must be absolute.', null, null);
  }

  if (options.allowRequestSafeProtocols && REQUEST_SAFE_PROTOCOLS.has(parsed.protocol) && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return decision(parsed.toString(), true, null, null, parsed.protocol.slice(0, -1));
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return decision(parsed.toString(), false, 'Only http and https URLs are allowed in the managed browser.', null, null);
  }

  const hostname = normalizeHostname(parsed.hostname);
  const allowedHosts = getAllowedHosts(env);
  if (allowedHosts.has(hostname)) {
    return decision(parsed.toString(), true, null, hostname, 'allowed-host');
  }

  if (ALWAYS_BLOCKED_HOSTS.has(hostname)) {
    return decision(parsed.toString(), false, 'Blocked browser access to a metadata or reserved host.', hostname, 'metadata');
  }

  if (hostname === 'localhost') {
    return decision(parsed.toString(), true, null, hostname, 'loopback');
  }

  const literalIpDecision = classifyIpAddress(hostname);
  if (literalIpDecision) {
    const applied = applyPrivateNetworkOverride(literalIpDecision, env);
    return decision(parsed.toString(), applied.allowed, applied.reason ?? null, hostname, applied.category);
  }

  if (options.lookupDns !== false) {
    try {
      const addresses = await lookupWithTimeout(hostname);
      for (const address of addresses) {
        const resolvedDecision = classifyIpAddress(address);
        if (!resolvedDecision) continue;
        const applied = applyPrivateNetworkOverride(resolvedDecision, env);
        if (!applied.allowed) {
          return decision(
            parsed.toString(),
            false,
            `${applied.reason || 'Blocked resolved address.'} Host resolved to ${address}.`,
            hostname,
            applied.category,
          );
        }
      }
    } catch (error) {
      return decision(
        parsed.toString(),
        false,
        error instanceof Error ? `Could not verify target host: ${error.message}` : 'Could not verify target host.',
        hostname,
        'dns-error',
      );
    }
  }

  return decision(parsed.toString(), true, null, hostname, 'public');
}

export async function assertBrowserNavigationUrlAllowed(rawUrl: string): Promise<string> {
  const result = await checkBrowserUrlPolicy(rawUrl, { lookupDns: true });
  if (!result.allowed) {
    throw new Error(result.reason || 'Browser navigation URL is blocked by policy.');
  }
  return result.url;
}

export async function isBrowserRequestUrlAllowed(rawUrl: string, options: BrowserUrlPolicyOptions = {}): Promise<BrowserUrlPolicyDecision> {
  return checkBrowserUrlPolicy(rawUrl, {
    ...options,
    allowRequestSafeProtocols: true,
  });
}
