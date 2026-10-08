import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:https';

const CALLBACK_ORIGIN = 'http://127.0.0.1:3001';
const CANONICAL_STATE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const HASH = /^[a-f0-9]{64}$/u;
const LIFETIME_MS = 10 * 60_000;
export type ComposioNativeConsentOptions = Readonly<{
  tls: Readonly<{ key: string | Buffer; cert: string | Buffer }>;
  controlToken: string;
  allowedCallbackOrigin: typeof CALLBACK_ORIGIN;
  fixtureNonce: string;
  cleanAuthorizationAddress: true;
}>;
export type ComposioNativeConsentStats = {
  sdkRequests: number; sessions: number; sdkLinks: number; accountReads: number; businessCalls: number;
  issued: number; consents: number; approvals: number; denials: number; callbackRedirects: number; rejectedConsentRequests: number;
};
export type ComposioNativeConsentFlowEvidence = Readonly<{
  flowHash: string; profileEntityHash: string; pendingAccountHash: string; authorizationUrlHash: string;
  toolkit: string; status: 'INITIATED' | 'ACTIVE' | 'FAILED';
  consents: number; approvals: number; denials: number; callbackRedirects: number;
}>;
type PendingAccount = { id: string; toolkit: string; status: string };
type ConsentRecord = {
  evidence: { -readonly [Key in keyof Omit<ComposioNativeConsentFlowEvidence, 'status'>]: Omit<ComposioNativeConsentFlowEvidence, 'status'>[Key] };
  account: PendingAccount;
  callback: string;
  expiresAt: number;
  decision: null | 'approve' | 'deny';
};

export function parseComposioNativeConsentOptions(value: unknown): ComposioNativeConsentOptions {
  const options = value as Partial<ComposioNativeConsentOptions> | null;
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !['tls', 'controlToken', 'allowedCallbackOrigin', 'fixtureNonce', 'cleanAuthorizationAddress'].includes(key))
    || options.allowedCallbackOrigin !== CALLBACK_ORIGIN || options.cleanAuthorizationAddress !== true
    || typeof options.fixtureNonce !== 'string' || !/^[a-f0-9]{32}$/u.test(options.fixtureNonce)
    || typeof options.controlToken !== 'string' || !CANONICAL_STATE.test(options.controlToken)
    || !options.tls || typeof options.tls !== 'object' || Array.isArray(options.tls)
    || Object.keys(options.tls).some(key => key !== 'key' && key !== 'cert')
    || ![options.tls.key, options.tls.cert].every(item => (typeof item === 'string' || Buffer.isBuffer(item)) && item.length > 0 && item.length < 64 * 1024)) {
    throw new Error('The owned native Composio consent options are invalid.');
  }
  return Object.freeze({ tls: Object.freeze({ ...options.tls }), controlToken: options.controlToken,
    allowedCallbackOrigin: CALLBACK_ORIGIN, fixtureNonce: options.fixtureNonce, cleanAuthorizationAddress: true });
}

export function validateComposioNativeCallback(raw: unknown): { href: string; flowHash: string } {
  if (typeof raw !== 'string' || raw.length > 4096 || /[\u0000-\u0020\u007f]/u.test(raw)) throw new Error('Invalid owned Composio callback.');
  const url = new URL(raw), flow = url.searchParams.get('flow');
  if (url.origin !== CALLBACK_ORIGIN || url.pathname !== '/api/composio/shared/desktop/callback'
    || url.username || url.password || url.hash || !flow || !CANONICAL_STATE.test(flow)
    || url.searchParams.size !== 1 || url.searchParams.getAll('flow').length !== 1
    || url.href !== `${CALLBACK_ORIGIN}/api/composio/shared/desktop/callback?flow=${flow}`) {
    throw new Error('Invalid owned Composio callback.');
  }
  return { href: url.href, flowHash: createHash('sha256').update(flow).digest('hex') };
}

async function readComposioNativeConsentBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += buffer.length;
    if (bytes > 4096) throw new Error('Invalid owned consent form.'); chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function writeComposioNativeConsentJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  response.end(JSON.stringify(value));
}

function escapeComposioNativeConsentHtml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');
}

/** An actual loopback HTTPS form; no control method can approve or activate an account. */
export async function createComposioNativeConsentFixture(input: ComposioNativeConsentOptions) {
  const options = parseComposioNativeConsentOptions(input);
  const stats: ComposioNativeConsentStats = { sdkRequests: 0, sessions: 0, sdkLinks: 0, accountReads: 0, businessCalls: 0,
    issued: 0, consents: 0, approvals: 0, denials: 0, callbackRedirects: 0, rejectedConsentRequests: 0 };
  const tickets = new Map<string, ConsentRecord>(), forms = new Map<string, ConsentRecord>(), flows = new Map<string, ConsentRecord>();
  let origin = '', closing: Promise<void> | undefined;
  const server = createServer(options.tls, async (request, response) => {
    try {
      const url = new URL(request.url || '/', origin), method = request.method || 'GET';
      if (url.origin !== origin || request.headers.host !== new URL(origin).host) throw new Error('Invalid owned consent origin.');
      if (method === 'GET' && url.pathname === '/favicon.ico' && !url.search) {
        response.writeHead(204, { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); response.end(); return;
      }
      if (method === 'GET' && url.pathname === '/authorize') {
        const ticket = url.searchParams.get('ticket');
        const record = ticket && CANONICAL_STATE.test(ticket) && url.searchParams.size === 1 && url.searchParams.getAll('ticket').length === 1 ? tickets.get(ticket) : undefined;
        if (!record || record.expiresAt <= Date.now() || record.decision || record.account.status !== 'INITIATED') throw new Error('Invalid owned consent.');
        const consent = randomBytes(32).toString('base64url'), nonce = randomBytes(24).toString('base64url');
        forms.set(consent, record); stats.consents += 1; record.evidence.consents += 1;
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin',
          'Content-Security-Policy': `default-src 'none'; form-action 'self' ${CALLBACK_ORIGIN}; frame-ancestors 'none'; base-uri 'none'; script-src 'nonce-${nonce}'` });
        response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Local Composio consent</title><script nonce="${nonce}">history.replaceState(null,'',location.pathname)</script></head><body><main><h1>Connect Canvas Notebook</h1><p>Allow the local ${escapeComposioNativeConsentHtml(record.account.toolkit)} account connection.</p><form method="post" action="/consent"><input type="hidden" name="consent" value="${consent}"><button type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny">Deny</button></form></main></body></html>`);
        return;
      }
      if (method === 'POST' && url.pathname === '/consent' && !url.search) {
        if (request.headers.origin !== origin || !/^application\/x-www-form-urlencoded(?:;|$)/iu.test(request.headers['content-type'] || '')
          || request.headers['sec-fetch-dest'] && request.headers['sec-fetch-dest'] !== 'document'
          || request.headers['sec-fetch-mode'] && request.headers['sec-fetch-mode'] !== 'navigate'
          || request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin') throw new Error('Invalid owned consent.');
        const body = new URLSearchParams(await readComposioNativeConsentBody(request)), consent = body.get('consent'), decision = body.get('decision');
        const record = consent && CANONICAL_STATE.test(consent) ? forms.get(consent) : undefined;
        if (!consent || !record || body.size !== 2 || body.getAll('consent').length !== 1 || body.getAll('decision').length !== 1
          || !['approve', 'deny'].includes(decision || '') || record.expiresAt <= Date.now() || record.decision || record.account.status !== 'INITIATED') throw new Error('Invalid owned consent.');
        const callback = new URL(validateComposioNativeCallback(record.callback).href);
        forms.delete(consent); record.decision = decision as 'approve' | 'deny';
        if (decision === 'approve') { record.account.status = 'ACTIVE'; record.evidence.approvals += 1; stats.approvals += 1; }
        else { record.account.status = 'FAILED'; record.evidence.denials += 1; stats.denials += 1; callback.searchParams.set('error', 'access_denied'); }
        record.evidence.callbackRedirects += 1; stats.callbackRedirects += 1;
        response.writeHead(303, { Location: callback.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); response.end(); return;
      }
      stats.rejectedConsentRequests += 1; writeComposioNativeConsentJson(response, 404, { error: 'not_found' });
    } catch {
      stats.rejectedConsentRequests += 1;
      if (!response.headersSent) writeComposioNativeConsentJson(response, 400, { error: 'invalid_request' }); else response.end();
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    origin,
    issue(value: { profileEntityId: string; pendingAccountId: string; toolkit: string; callbackUrl: string }, account: PendingAccount): string {
      const callback = validateComposioNativeCallback(value.callbackUrl);
      if (flows.size >= 32 || flows.has(callback.flowHash) || !value.profileEntityId || value.profileEntityId.length > 256
        || !value.pendingAccountId || value.pendingAccountId.length > 256 || !/^[a-z0-9][a-z0-9_-]{0,99}$/u.test(value.toolkit)
        || value.profileEntityId !== value.profileEntityId.trim() || value.pendingAccountId !== value.pendingAccountId.trim()
        || /[\x00-\x1f\x7f]/u.test(value.profileEntityId + value.pendingAccountId)
        || account.id !== value.pendingAccountId || account.toolkit !== value.toolkit || account.status !== 'INITIATED') throw new Error('Invalid owned account consent.');
      const ticket = randomBytes(32).toString('base64url'), address = `${origin}/authorize?ticket=${ticket}`;
      const record: ConsentRecord = { callback: callback.href, account, expiresAt: Date.now() + LIFETIME_MS, decision: null,
        evidence: { flowHash: callback.flowHash, profileEntityHash: createHash('sha256').update(value.profileEntityId).digest('hex'),
          pendingAccountHash: createHash('sha256').update(value.pendingAccountId).digest('hex'), authorizationUrlHash: createHash('sha256').update(address).digest('hex'),
          toolkit: value.toolkit, consents: 0, approvals: 0, denials: 0, callbackRedirects: 0 } };
      tickets.set(ticket, record); flows.set(callback.flowHash, record); stats.issued += 1; return address;
    },
    observe(field: 'sdkRequests' | 'sessions' | 'sdkLinks' | 'accountReads' | 'businessCalls'): void { stats[field] += 1; },
    readStats(): Readonly<ComposioNativeConsentStats> { return Object.freeze({ ...stats }); },
    readFlow(flowHash?: string): ComposioNativeConsentFlowEvidence[] {
      if (flowHash !== undefined && !HASH.test(flowHash)) throw new Error('Invalid owned flow hash.');
      const selected = flowHash === undefined ? [...flows.values()] : flows.has(flowHash) ? [flows.get(flowHash)!] : [];
      return selected.map(record => {
        if (!['INITIATED', 'ACTIVE', 'FAILED'].includes(record.account.status)) throw new Error('Invalid owned account observation.');
        return Object.freeze({ ...record.evidence, status: record.account.status as ComposioNativeConsentFlowEvidence['status'] });
      });
    },
    close(): Promise<void> {
      closing ||= new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
      }).finally(() => { tickets.clear(); forms.clear(); flows.clear(); });
      return closing;
    },
  };
}
