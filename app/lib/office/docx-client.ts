/** Browser transport. Every request captures explicit workspace headers. */
export interface DocxIdentity {
  accountId: string;
  workspaceId: string;
  path: string;
  lineageId: string;
  sessionId: string;
}

export interface DocxBaseline { sha256: string; revisionId: string }
export interface DocxLease { id: string; expiresAt: number }
export interface DocxSaveRequest {
  path: string;
  sessionId: string;
  lockId: string;
  expectedSha256: string;
  baseRevisionId: string;
  idempotencyKey: string;
  bytes: Uint8Array;
}
export interface DocxSaveClient {
  acquire(path: string, sessionId: string, baseRevisionId: string, ttlMs: number, signal?: AbortSignal): Promise<DocxLease>;
  renew(path: string, sessionId: string, lockId: string, ttlMs: number, signal?: AbortSignal): Promise<DocxLease>;
  release(path: string, sessionId: string, lockId: string): Promise<void>;
  write(request: DocxSaveRequest, signal?: AbortSignal): Promise<DocxBaseline>;
}

export class DocxClientError extends Error {
  constructor(message: string, public readonly code: string, public readonly status = 0) {
    super(message);
    this.name = 'DocxClientError';
  }
}

export function docxBytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  }
  return `base64:${btoa(chunks.join(''))}`;
}

export function docxBase64ToBytes(content: string): Uint8Array {
  if (!content.startsWith('base64:')) throw new DocxClientError('Invalid DOCX response.', 'INVALID_RESPONSE');
  return Uint8Array.from(atob(content.slice(7)), (character) => character.charCodeAt(0));
}

export function createDocxClient(options: {
  workspaceId: string;
  workspaceHeaders: HeadersInit;
  fetchImpl?: typeof fetch;
}) {
  const fetcher = options.fetchImpl ?? fetch;
  const headers = new Headers(options.workspaceHeaders);
  const workspaceId = options.workspaceId;
  async function request<T>(url: string, method: string, body?: object, signal?: AbortSignal): Promise<T> {
    const requestHeaders = new Headers(headers);
    if (body) requestHeaders.set('Content-Type', 'application/json');
    const response = await fetcher(url, {
      method, headers: requestHeaders, cache: 'no-store', credentials: 'same-origin', signal,
      ...(method === 'DELETE' ? { keepalive: true } : {}),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let payload: { success?: boolean; data?: T; error?: string; code?: string };
    try { payload = await response.json(); } catch {
      throw new DocxClientError('The document server returned an unreadable response.', 'INVALID_RESPONSE', response.status);
    }
    if (!response.ok || payload.success !== true || !payload.data) {
      throw new DocxClientError(payload.error ?? 'Document request failed.', payload.code ?? 'REQUEST_FAILED', response.status);
    }
    return payload.data;
  }
  const client: DocxSaveClient = {
    async acquire(path, sessionId, baseRevisionId, ttlMs, signal) {
      return (await request<{ lock: DocxLease }>('/api/files/locks', 'POST', { path, sessionId, baseRevisionId, ttlMs }, signal)).lock;
    },
    async renew(path, sessionId, lockId, ttlMs, signal) {
      return (await request<{ lock: DocxLease }>('/api/files/locks', 'PATCH', { path, sessionId, lockId, ttlMs }, signal)).lock;
    },
    async release(path, sessionId, lockId) {
      await request('/api/files/locks', 'DELETE', { path, sessionId, lockId });
    },
    async write(value, signal) {
      const { bytes, ...body } = value;
      const data = await request<{ stats: { sha256: string }; revision: { id: string } }>(
        '/api/files/write', 'POST', { ...body, content: docxBytesToBase64(bytes) }, signal,
      );
      if (!data.stats?.sha256 || !data.revision?.id) throw new DocxClientError('Missing saved document revision.', 'INVALID_RESPONSE');
      return { sha256: data.stats.sha256, revisionId: data.revision.id };
    },
  };
  return {
    ...client,
    async read(path: string, signal?: AbortSignal) {
      const data = await request<{
        content: string; stats: { sha256: string }; revision: { id: string };
        collaboration: { lineageId: string }; viewerUserId: string; workspaceId: string;
        editorCompatibility?: { editable: boolean; reasons: string[] };
      }>(`/api/files/read?path=${encodeURIComponent(path)}`, 'GET', undefined, signal);
      if (data.workspaceId !== workspaceId || !data.viewerUserId || !data.collaboration?.lineageId || !data.stats?.sha256 || !data.revision?.id) {
        throw new DocxClientError('The document identity does not match this workspace.', 'INVALID_IDENTITY');
      }
      return {
        bytes: docxBase64ToBytes(data.content),
        baseline: { sha256: data.stats.sha256, revisionId: data.revision.id },
        accountId: data.viewerUserId, workspaceId: data.workspaceId, lineageId: data.collaboration.lineageId,
        editorCompatibility: data.editorCompatibility,
      };
    },
    versions(path: string, signal?: AbortSignal, lineageId?: string): Promise<unknown> {
      return request(`/api/files/office/versions?path=${encodeURIComponent(path)}${lineageId ? `&lineageId=${encodeURIComponent(lineageId)}` : ''}`, 'GET', undefined, signal);
    },
  };
}
