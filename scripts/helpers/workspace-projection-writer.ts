import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

type Input = Readonly<{ workspaceId: string; filePath: string; gated: boolean } & (
  { mode: 'create'; content: string } | { mode: 'republish' }
)>;

/** A separate real kernel-lock participant. Republish replaces only this owned
 * fixture projection, byte for byte; it never changes registry/Yjs metadata. */
export function startWorkspaceProjectionWriter(input: Input) {
  assert(path.isAbsolute(input.filePath) && !input.filePath.includes('\0'));
  assert(input.workspaceId && !input.workspaceId.includes('\0'));
  const lockModule = pathToFileURL(path.resolve('app/lib/files/workspace-mutation-lock.ts')).href;
  const publication = input.mode === 'create'
    ? `await fs.writeFile(${JSON.stringify(input.filePath)}, ${JSON.stringify(input.content)}, { mode: 0o600 });`
    : `const file = ${JSON.stringify(input.filePath)}, temporary = file + '.projection-' + randomUUID();
       const bytes = await fs.readFile(file);
       try { await fs.writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, file); }
       finally { await fs.rm(temporary, { force: true }); }`;
  const source = `import fs from 'node:fs/promises';
    import { randomUUID } from 'node:crypto';
    import { withWorkspaceMutationLock } from ${JSON.stringify(lockModule)};
    const gate = new Promise(resolve => process.stdin.once('data', resolve));
    console.log('attempting');
    await withWorkspaceMutationLock(${JSON.stringify(input.workspaceId)}, async () => {
      console.log('acquired');
      ${input.gated ? 'await gate;' : ''}
      ${publication}
      console.log('published');
    });
    process.stdin.destroy();
    console.log('released');`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--conditions', 'react-server', '--input-type=module', '--eval', source],
    { cwd: process.cwd(), env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const events = new Set<string>(), listeners = new Map<string, () => void>();
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString(); let newline: number;
    while ((newline = stdout.indexOf('\n')) >= 0) {
      const event = stdout.slice(0, newline); stdout = stdout.slice(newline + 1);
      events.add(event); listeners.get(event)?.(); listeners.delete(event);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2_000); });
  const exit = once(child, 'exit');
  const wait = async (event: string) => {
    if (events.has(event)) return;
    const arrived = new Promise<void>(resolve => { listeners.set(event, resolve); });
    await Promise.race([arrived, exit.then(() => { throw new Error(`Projection writer exited before ${event}: ${stderr}`); }),
      delay(10_000, undefined, { ref: false }).then(() => { throw new Error(`Projection writer did not reach ${event}.`); })]);
  };
  const close = async () => {
    child.stdin.end('publish\n');
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([exit, delay(3_000, undefined, { ref: false }).then(() => { child.kill('SIGKILL'); })]);
    }
    await exit;
  };
  return { child, events, wait, exit, close };
}
