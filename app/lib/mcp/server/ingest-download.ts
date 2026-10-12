import {
  readBoundedResponseBody,
  requestPublicHttpUrl,
} from '@/app/lib/security/safe-external-fetch';

import { DIRECT_MCP_INGEST_MAX_BINARY_BYTES } from './ingest-validation';

export const DIRECT_MCP_INGEST_DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;
const MAX_DOWNLOAD_URL_LENGTH = 16_384;
const MAX_FILE_ID_LENGTH = 512;

export type DirectMcpFileReference = {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
};

export type DirectMcpIngestDownloadCode =
  | 'invalid_file_reference'
  | 'unsafe_download_url'
  | 'download_failed'
  | 'download_too_large'
  | 'download_cancelled'
  | 'download_timeout';

export class DirectMcpIngestDownloadError extends Error {
  constructor(readonly code: DirectMcpIngestDownloadCode, message: string) {
    super(message);
    this.name = 'DirectMcpIngestDownloadError';
  }
}

function assertFileReference(file: DirectMcpFileReference): void {
  if (!file || typeof file !== 'object'
    || typeof file.download_url !== 'string' || !file.download_url.trim()
    || file.download_url.length > MAX_DOWNLOAD_URL_LENGTH
    || typeof file.file_id !== 'string' || !file.file_id.trim()
    || file.file_id.length > MAX_FILE_ID_LENGTH || /[\u0000-\u001f\u007f]/u.test(file.file_id)
    || (file.mime_type !== undefined && (typeof file.mime_type !== 'string' || file.mime_type.length > 200
      || /[\r\n]/u.test(file.mime_type)))
    || (file.file_name !== undefined && (typeof file.file_name !== 'string' || file.file_name.length > 1_024
      || /[\u0000-\u001f\u007f]/u.test(file.file_name)))) {
    throw new DirectMcpIngestDownloadError('invalid_file_reference', 'Provide a valid host file reference containing download_url and file_id.');
  }
}

function httpsDownloadUrl(value: string, base?: URL): URL {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new DirectMcpIngestDownloadError('unsafe_download_url', 'The file download URL is invalid. Provide a fresh HTTPS file reference.');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new DirectMcpIngestDownloadError('unsafe_download_url', 'File downloads require HTTPS and cannot contain URL credentials.');
  }
  if (url.toString().length > MAX_DOWNLOAD_URL_LENGTH) {
    throw new DirectMcpIngestDownloadError('unsafe_download_url', 'The file download URL exceeds the supported length. Provide a fresh file reference.');
  }
  return url;
}

function cancelResponse(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

/** Download original bytes through the public, DNS-pinned network boundary. */
export async function downloadDirectMcpFile(
  file: DirectMcpFileReference,
  cancellation?: AbortSignal,
): Promise<{ content: Buffer; mimeType: string }> {
  assertFileReference(file);
  let currentUrl = httpsDownloadUrl(file.download_url);
  const timeout = AbortSignal.timeout(DIRECT_MCP_INGEST_DOWNLOAD_TIMEOUT_MS);
  const signal = cancellation ? AbortSignal.any([cancellation, timeout]) : timeout;

  try {
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
      signal.throwIfAborted();
      // Only the shared transport's Host header is sent. Canvas OAuth tokens,
      // browser cookies and caller-controlled authorization are never forwarded.
      const response = await requestPublicHttpUrl(currentUrl, {
        timeoutMs: DIRECT_MCP_INGEST_DOWNLOAD_TIMEOUT_MS,
        signal,
      });

      if (response.status >= 300 && response.status < 400) {
        cancelResponse(response);
        const location = response.headers.get('location');
        if (!location || redirectCount === MAX_REDIRECTS) {
          throw new DirectMcpIngestDownloadError('download_failed', 'The file host returned an invalid redirect chain. Provide a fresh file reference.');
        }
        // Validate every redirect before DNS or a subsequent network request.
        currentUrl = httpsDownloadUrl(location, currentUrl);
        continue;
      }

      if (!response.ok || response.status === 206 || response.headers.has('content-range')) {
        cancelResponse(response);
        throw new DirectMcpIngestDownloadError('download_failed', 'The file host did not return a complete successful response. The reference may have expired.');
      }
      // This raw transport does not decode HTTP content encodings. A host
      // must return the original representation, not a compressed envelope.
      const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
      if (encoding && encoding !== 'identity') {
        cancelResponse(response);
        throw new DirectMcpIngestDownloadError('download_failed', 'The file host returned an encoded response instead of original file bytes. Provide a direct file reference.');
      }
      const advertisedSize = Number(response.headers.get('content-length'));
      if (Number.isFinite(advertisedSize) && advertisedSize > DIRECT_MCP_INGEST_MAX_BINARY_BYTES) {
        cancelResponse(response);
        throw new DirectMcpIngestDownloadError('download_too_large', 'File imports may contain at most 25 MiB.');
      }

      const content = await readBoundedResponseBody(response, DIRECT_MCP_INGEST_MAX_BINARY_BYTES, signal);
      return {
        content,
        mimeType: file.mime_type?.trim() || response.headers.get('content-type') || 'application/octet-stream',
      };
    }
    throw new DirectMcpIngestDownloadError('download_failed', 'The file host returned too many redirects.');
  } catch (error) {
    if (cancellation?.aborted) {
      throw new DirectMcpIngestDownloadError('download_cancelled', 'The file download was cancelled.');
    }
    if (timeout.aborted) {
      throw new DirectMcpIngestDownloadError('download_timeout', 'The file download exceeded the 30-second time limit. Provide a fresh file reference and retry.');
    }
    if (error instanceof DirectMcpIngestDownloadError) throw error;
    if (error instanceof Error && error.message.startsWith('Remote file exceeds ')) {
      throw new DirectMcpIngestDownloadError('download_too_large', 'File imports may contain at most 25 MiB.');
    }
    // DNS, TLS and remote status errors may contain signed URLs or tokens.
    // Return a fixed diagnostic without propagating the original error/cause.
    throw new DirectMcpIngestDownloadError('download_failed', 'The file could not be downloaded securely. Check that the HTTPS reference is current and its host is publicly reachable.');
  }
}
