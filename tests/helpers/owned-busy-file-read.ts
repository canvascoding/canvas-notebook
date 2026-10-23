import type { APIResponse } from '@playwright/test';
import { revalidateBusyFileRead } from '../../app/lib/files/read-busy';

/** Test-only APIResponse adapter. Every retry is a fresh GET under the existing
 * product policy; copied bodies remain readable after Playwright disposal. */
export function revalidateOwnedBusyFileRead(request: () => Promise<APIResponse>,
  signal: AbortSignal = new AbortController().signal): Promise<Response> {
  return revalidateBusyFileRead(async () => {
    const response = await request();
    try {
      const status = response.status(), statusText = response.statusText();
      const headers = response.headersArray().map(({ name, value }) => [name, value] as [string, string]);
      const bytes = await response.body();
      return new Response([204, 205, 304].includes(status) ? null : new Uint8Array(bytes), { status, statusText, headers });
    } finally { await response.dispose(); }
  }, signal);
}
