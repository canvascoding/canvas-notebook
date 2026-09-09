import { spawn } from 'node:child_process';
import { readStoredToolOutput, type ToolOutputIdentity } from './tool-output-store';
import { readTextWindow } from './text-read-window';

/** Ask ripgrep for offsets only: even a multi-megabyte JSON line or `.*` match
 * cannot expand stdout. Stop after 21 matches and display at most 20 windows. */
export async function searchStoredToolOutput(identity: ToolOutputIdentity, reference: string, pattern: string,
  options: { ignoreCase?: boolean; maxResults?: number; signal?: AbortSignal } = {}) {
  const stored = await readStoredToolOutput(identity, reference);
  const limit = Math.max(1, Math.min(20, Math.trunc(options.maxResults ?? 20) || 20));
  const bytes = Buffer.from(stored.content, 'utf8');
  const offsets = await new Promise<number[]>((resolve, reject) => {
    const args = ['--no-config', '--engine', 'default', '--text', '--only-matching', '--byte-offset', '--replace', '', '--no-line-number', '--no-filename'];
    if (options.ignoreCase) args.push('--ignore-case');
    args.push('-e', pattern, '--', '-');
    const child = spawn('rg', args, { signal: options.signal, stdio: ['pipe', 'pipe', 'pipe'] });
    const found: number[] = [];
    let pending = '', error = '', stopped = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 10_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stopped) return;
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (/^\d+:$/.test(line)) found.push(Number(line.slice(0, -1)));
        if (found.length > limit) { stopped = true; child.kill(); break; }
      }
    });
    child.stderr.on('data', (chunk: string) => { error = (error + chunk).slice(0, 2000); });
    child.stdin.on('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') reject(err); });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (options.signal?.aborted) reject(new Error('Tool execution aborted.'));
      else if (timedOut) reject(new Error('Stored output search timed out.'));
      else if (stopped || code === 0 || code === 1) resolve(found);
      else reject(new Error(error || 'Stored output search failed.'));
    });
    child.stdin.end(bytes);
  });
  const matches = offsets.slice(0, limit).map((byteOffset) => {
    const matchOffset = bytes.subarray(0, byteOffset).toString('utf8').length;
    const window = readTextWindow(stored.content, Math.max(0, matchOffset - 60), 180);
    return { matchOffset, offset: window.offset, text: window.text };
  });
  const text = [`Source: ${reference}`, 'Offsets use UTF-16 characters. Pass offset to read for more context.',
    ...matches.map((match) => `matchOffset=${match.matchOffset}; read offset=${match.offset}\n${match.text}`),
    offsets.length > limit ? `More matches omitted; narrow the pattern (showing ${limit}).` : matches.length ? '' : '(no matches found)',
  ].filter(Boolean).join('\n');
  return { content: [{ type: 'text' as const, text }], details: { matches, truncated: offsets.length > limit } };
}
