import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';

async function main() {
  const source = ts.createSourceFile('recovery-operator.ts', await fs.readFile('app/lib/collaboration/recovery-operator.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const selected = source.statements.filter(statement => ts.isFunctionDeclaration(statement)
    && ['durablePrivateWrite', 'canonical'].includes(statement.name?.text ?? ''));
  assert.equal(selected.length, 2);
  const javascript = ts.transpileModule(selected.map(statement => statement.getText(source)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-recovery-journal-'));
  const filename = path.join(directory, 'intent.json'); const value = { originalHash: 'a'.repeat(64), payload: 'x'.repeat(1024 * 1024) };
  try {
    const child = `const fs=require('node:fs').promises;const path=require('node:path');const {randomUUID}=require('node:crypto');
      const realOpen=fs.open.bind(fs);fs.open=async (...args)=>{const handle=await realOpen(...args);if(args[1]==='wx')handle.writeFile=async()=>{
        await handle.write('incomplete');await handle.sync();process.exit(73)};return handle};
      ${javascript}\ndurablePrivateWrite(process.argv[1],{originalHash:'a'.repeat(64),payload:'x'.repeat(1024*1024)}).catch(()=>process.exit(1));`;
    await assert.rejects(promisify(execFile)(process.execPath, ['-e', child, filename]), (error: unknown) =>
      error && typeof error === 'object' && 'code' in error && error.code === 73);
    await assert.rejects(fs.stat(filename), { code: 'ENOENT' }, 'a crash while writing a temp never publishes partial intent');
    const temps = await fs.readdir(directory); assert.equal(temps.length, 1); assert.match(temps[0], /^\.intent\.json\.tmp-/u);
    assert.equal(await fs.readFile(path.join(directory, temps[0]), 'utf8'), 'incomplete');
    const write = new Function('fs', 'path', 'randomUUID', `${javascript}\nreturn durablePrivateWrite;`)(fs, path, randomUUID) as (filename: string, value: unknown) => Promise<void>;
    await write(filename, value);
    assert.deepEqual(JSON.parse(await fs.readFile(filename, 'utf8')), value);
    assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
    await assert.rejects(write(filename, { replaced: true }), { code: 'EEXIST' });
    assert.deepEqual(JSON.parse(await fs.readFile(filename, 'utf8')), value, 'an existing durable marker is never replaced');
    assert.equal((await fs.readdir(directory)).length, 2, 'failed duplicate publication cleans only its own new temp');
    console.log('Recovery journal: actual process crash, atomic exclusive publication, fsync, stable original and safe temp restart passed.');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
