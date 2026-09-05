import readline from 'node:readline';
import type { Readable } from 'node:stream';
import type { SystemUpdateEventReporter } from './systemUpdateReporter';

export function systemUpdateApplyAcknowledgement(operationId: string): string {
  return `canvas-update-apply:${operationId}`;
}

/** Install cannot begin until the host durably records that cancellation is closed. */
export async function beginSystemUpdateApply(
  reporter: SystemUpdateEventReporter,
  options: { required: boolean; input?: Readable; timeoutMs?: number },
): Promise<void> {
  const announce = () => reporter.running('image_pull', 'Pulling the pinned Canvas Notebook image.');
  if (!options.required) { announce(); return; }
  const input = options.input || process.stdin;
  await new Promise<void>((resolve, reject) => {
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    const timer = setTimeout(() => finish(new Error('Host update apply acknowledgement timed out.')), options.timeoutMs ?? 30_000);
    let settled = false;
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      input.pause();
      input.removeListener('error', onError);
      if (error) reject(error); else resolve();
    }
    function onError(error: Error) { finish(error); }
    input.once('error', onError);
    lines.once('close', () => finish(new Error('Host disconnected before update apply acknowledgement.')));
    lines.once('line', (line) => finish(line === systemUpdateApplyAcknowledgement(reporter.operationId)
      ? undefined : new Error('Host update apply acknowledgement is invalid.')));
    try { announce(); } catch (error) { finish(error instanceof Error ? error : new Error('Update announcement failed.')); }
  });
}
