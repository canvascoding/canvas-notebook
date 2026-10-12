import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';
import { resolvePublicNetworkAddress } from './security/safe-external-fetch.js';
import { DecisionModelError } from './errors.js';
import type { DecisionProviderConfiguration } from './types.js';

const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const OPENAI_DECISIONS_ENDPOINT = 'https://api.openai.com/v1/decisions';

function rejectEndpoint(providerId: string): never {
  throw new DecisionModelError('endpoint_rejected', { providerId });
}

/** Normalize only trusted provider configuration; credentials must never be embedded in URLs. */
export function normalizeDecisionEndpoint(configuration: DecisionProviderConfiguration): URL {
  const fixedEndpoint = configuration.providerId === 'typesafe' ? TYPESAFE_ENDPOINT
    : configuration.providerId === 'openai-decisions' ? OPENAI_DECISIONS_ENDPOINT : undefined;
  if (fixedEndpoint) {
    if (configuration.endpoint && configuration.endpoint !== fixedEndpoint) rejectEndpoint(configuration.providerId);
    return new URL(fixedEndpoint);
  }
  if (!configuration.endpoint) throw new DecisionModelError('missing_configuration', { providerId: configuration.providerId });
  try {
    const url = new URL(configuration.endpoint.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) rejectEndpoint(configuration.providerId);
    if (!configuration.allowPrivateNetwork && (url.protocol !== 'https:' || (url.port && url.port !== '443'))) rejectEndpoint(configuration.providerId);
    const hostname = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
    if (isForbiddenInternalTarget(hostname)) rejectEndpoint(configuration.providerId);
    if (!configuration.allowPrivateNetwork && (hostname === 'localhost' || hostname.endsWith('.localhost'))) rejectEndpoint(configuration.providerId);
    const path = url.pathname.replace(/\/+$/u, '');
    url.pathname = path.endsWith('/v1/systemone') ? path : path.endsWith('/v1') ? `${path}/systemone` : `${path}/v1/systemone`;
    return url;
  } catch (error) {
    if (error instanceof DecisionModelError) throw error;
    return rejectEndpoint(configuration.providerId);
  }
}

/** Metadata/link-local/unspecified/multicast destinations remain blocked even for a local model. */
function isForbiddenInternalTarget(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/gu, '');
  if (normalized === 'metadata.google.internal' || normalized.endsWith('.metadata.google.internal')) return true;
  if (net.isIP(normalized) === 6) {
    const first = Number.parseInt(normalized.split(':')[0] || '0', 16);
    if (normalized === '::' || normalized === 'fd00:ec2::254'
      || first >= 0xfe80 && first <= 0xfebf || first >= 0xff00) return true;
    // URL canonicalization writes mapped IPv4 as hex; inspect both supported notations.
    if (normalized.startsWith('::ffff:')) {
      const suffix = normalized.slice('::ffff:'.length);
      if (net.isIP(suffix) === 4) return isForbiddenInternalTarget(suffix);
      const words = suffix.split(':').map(word => Number.parseInt(word, 16));
      if (words.length !== 2 || words.some(word => !Number.isInteger(word) || word < 0 || word > 65535)) return true;
      return isForbiddenInternalTarget(`${words[0] >> 8}.${words[0] & 255}.${words[1] >> 8}.${words[1] & 255}`);
    }
  }
  const ipv4 = net.isIP(normalized) === 4 ? normalized.split('.').map(Number) : null;
  return Boolean(ipv4 && (ipv4[0] === 0 || ipv4[0] === 169 && ipv4[1] === 254 || ipv4[0] >= 224));
}

async function resolveDecisionAddress(url: URL, configuration: DecisionProviderConfiguration): Promise<{ address: string; family: 4 | 6 }> {
  try {
    if (configuration.providerId === 'typesafe' || configuration.providerId === 'openai-decisions'
      || !configuration.allowPrivateNetwork) return await resolvePublicNetworkAddress(url);
    const hostname = url.hostname.replace(/^\[|\]$/gu, '');
    const family = net.isIP(hostname);
    const addresses = family ? [{ address: hostname, family }] : await dns.lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(entry => isForbiddenInternalTarget(entry.address))) rejectEndpoint(configuration.providerId);
    const selected = addresses[0];
    if (selected.family !== 4 && selected.family !== 6) rejectEndpoint(configuration.providerId);
    return { address: selected.address, family: selected.family };
  } catch (error) {
    if (error instanceof DecisionModelError) throw error;
    // DNS and endpoint policy failures must not expose the configured endpoint.
    return rejectEndpoint(configuration.providerId);
  }
}

/** Pinned DNS, explicit body, bounded caller signal and no automatic redirect following. */
export async function requestDecisionHttp(url: URL, configuration: DecisionProviderConfiguration, options: {
  body: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<Response> {
  const target = await resolveDecisionAddress(url, configuration);
  options.signal.throwIfAborted();
  return new Promise<Response>((resolve, reject) => {
    const headers = new Headers(options.headers);
    headers.set('host', url.host);
    headers.set('content-length', String(Buffer.byteLength(options.body)));
    const send = url.protocol === 'https:' ? https.request : http.request;
    const request = send({
      protocol: url.protocol,
      hostname: target.address,
      family: target.family,
      port: url.port ? Number(url.port) : undefined,
      path: url.pathname,
      method: 'POST',
      headers: Object.fromEntries(headers),
      servername: url.protocol === 'https:' ? url.hostname.replace(/^\[|\]$/gu, '') : undefined,
      signal: options.signal,
    }, response => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) value.forEach(entry => responseHeaders.append(name, entry));
        else if (value !== undefined) responseHeaders.set(name, value);
      }
      const status = response.statusCode && response.statusCode >= 200 && response.statusCode <= 599 ? response.statusCode : 502;
      resolve(new Response(status === 204 || status === 304 ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>, {
        status,
        headers: responseHeaders,
      }));
    });
    request.setTimeout(options.timeoutMs, () => request.destroy(new Error('Decision request timed out.')));
    request.once('error', reject);
    request.end(options.body);
  });
}
