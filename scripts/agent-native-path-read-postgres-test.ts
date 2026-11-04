import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';
import { withNativeApiKeyEditRuntime } from './helpers/native-api-key-edit-runtime';

type Row = Record<string, unknown>;
let stage = 'setup', groups = 0, complete = false;
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });
function object(value: unknown): Row {
  assert(value && typeof value === 'object' && !Array.isArray(value)); return value as Row;
}
function text(output: AgentToolResult<unknown>): string {
  return output.content.filter(value => value.type === 'text').map(value => value.text).join('\n');
}
function success(output: AgentToolResult<unknown>): Row {
  assert.notEqual(Reflect.get(output, 'isError'), true, text(output)); return object(output.details);
}
async function main() {
  await withDocumentReadToolDispatchFixture(async h => {
    await h.setPiEnabledTools(['read']);
    const { getPiTools, piTools } = await import('../app/lib/pi/tool-registry');
    const { validateToolArguments } = await import('@earendil-works/pi-ai');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const { resolveAgentExecutionContextForSession } = await import('../app/lib/pi/session-workspace-context');
    const { resolveAgentRuntimeTempDir } = await import('../app/lib/pi/agent-runtime-temp');
    const tool = (await getPiTools('reader', h.agentId, h.piSessionId,
      { strictAuthorization: true, metadataOnlyExternal: true })).find(value => value.name === 'read'); assert(tool);
    const invoke = async (selected: AgentTool, args: Row) => {
      const id = `native-path-read-${crypto.randomUUID()}`, prepared = selected.prepareArguments ? selected.prepareArguments(args) : args;
      const validated = validateToolArguments(selected, { type: 'toolCall', id, name: selected.name,
        arguments: prepared as Parameters<typeof validateToolArguments>[1]['arguments'] });
      return selected.execute(id, validated);
    };
    const denied = async (operation: () => Promise<AgentToolResult<unknown>>, forbidden: string) => {
      try { const output = await operation(); assert.equal(Reflect.get(output, 'isError'), true);
        assert.equal(text(output).includes(forbidden), false); assert.equal(object(output.details).collaboration, undefined); }
      catch (error) { if (error instanceof assert.AssertionError) throw error; }
    };
    const check = async (name: string, operation: () => Promise<void>) => {
      stage = name; await operation(); groups++;
      console.log(JSON.stringify({ suite: 'agent-native-path-read-group', name, passed: true }));
    };
    const document = await h.seed({ filePath: 'logical/native-only.md', text: 'Authoritative native content without a projection. 🧪' });
    const full = path.join(h.workspaceRoot, document.filePath);
    await check('real registered native-only Read preserves rows and reports durable persisted currency', async () => {
      await assert.rejects(fs.stat(full), { code: 'ENOENT' }); const before = await h.snapshot();
      const output = await invoke(tool, { path: document.filePath }), details = success(output);
      assert(text(output).includes(document.text)); assert.equal(details.sha256, crypto.createHash('sha256').update(document.text).digest('hex'));
      const collaboration = object(details.collaboration), currency = object(collaboration.currency);
      assert.equal(collaboration.documentId, document.documentId); assert.equal(collaboration.source, 'persisted_yjs');
      assert.equal(currency.durable, true); assert.equal(currency.observedStateProof, currency.persistedStateProof);
      assert.deepEqual(await h.snapshot(), before); await assert.rejects(fs.stat(full), { code: 'ENOENT' });
    });
    await check('plain XML blocks empty and native non-Markdown suffixes read native state with bounded block IDs and hashes', async () => {
      for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
        const target = await h.seed({ filePath: `native-${representation}.payload`, representation, text: 'Native body 🧪' });
        const before = await h.snapshot(), output = await invoke(tool, { path: target.filePath }), details = success(output);
        assert(text(output).includes(target.text)); assert.equal(object(details.collaboration).representation, representation);
        assert.deepEqual(await h.snapshot(), before); await assert.rejects(fs.stat(path.join(h.workspaceRoot, target.filePath)), { code: 'ENOENT' });
      }
      const empty = await h.seed({ filePath: 'empty.md', text: '' });
      const nativePdf = await h.seed({ filePath: 'native.pdf', text: 'Native text, not physical PDF bytes.' });
      const blocks = await h.seed({ filePath: 'blocks.md', representation: 'tiptap_blocks', text: '# Heading\n\nFirst paragraph.\n\nSecond paragraph.' });
      const before = await h.snapshot(); assert.equal(success(await invoke(tool, { path: empty.filePath })).size, 0);
      const pdf = await invoke(tool, { path: nativePdf.filePath }); assert.equal(success(pdf).type, 'text'); assert(text(pdf).includes(nativePdf.text));
      const first = success(await invoke(tool, { path: blocks.filePath, source: 'blocks', structureLimit: 1, maxChars: 10000 }));
      const structure = object(first.structure); assert(Array.isArray(structure.blocks)); assert.equal(structure.blocks.length, 1);
      const block = object(structure.blocks[0]); assert.equal(typeof block.id, 'string'); assert.match(String(block.subtreeHash), /^[a-f0-9]{64}$/u);
      assert.match(String(block.placementHash), /^[a-f0-9]{64}$/u); assert.equal(structure.nextOffset, 1);
      const second = success(await invoke(tool, { path: blocks.filePath, source: 'blocks', structureOffset: structure.nextOffset, structureLimit: 1, maxChars: 10000 }));
      const secondBlocks = object(second.structure).blocks; assert(Array.isArray(secondBlocks)); assert.notEqual(object(secondBlocks[0]).id, block.id);
      assert.equal(object(first.collaboration).documentId, blocks.documentId); assert.deepEqual(await h.snapshot(), before);
    });
    await check('stale physical checkpoints never replace initialized native data', async () => {
      await fs.mkdir(path.dirname(full), { recursive: true }); await fs.writeFile(full, 'STALE PHYSICAL CHECKPOINT');
      const before = await h.snapshot(), output = await invoke(tool, { path: document.filePath }); success(output);
      assert(text(output).includes(document.text)); assert.equal(text(output).includes('STALE PHYSICAL CHECKPOINT'), false);
      assert.equal(await fs.readFile(full, 'utf8'), 'STALE PHYSICAL CHECKPOINT'); assert.deepEqual(await h.snapshot(), before); await fs.unlink(full);
    });
    await check('unregistered and pristine physical Markdown reads create no native document state revision or projection', async () => {
      const id = `pristine-${crypto.randomUUID()}`, lineage = `lineage-${crypto.randomUUID()}`;
      await h.admin.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,organization_id,path,status,created_at)
        VALUES($1,$2,'organization','tool-dispatch-org','pristine.md','active',100)`, [lineage, h.workspaceId]);
      await h.admin.query(`INSERT INTO collaboration_documents(id,lineage_id,workspace_id,workspace_type,organization_id,path,provider,
        state_version,yjs_state_lifecycle,status,created_at,updated_at)
        VALUES($1,$2,$3,'organization','tool-dispatch-org','pristine.md','yjs',0,'never_initialized','active',100,100)`, [id, lineage, h.workspaceId]);
      for (const name of ['unregistered.md', 'pristine.md']) await fs.writeFile(path.join(h.workspaceRoot, name), `Physical bytes: ${name}\r\n`);
      const before = await h.snapshot();
      for (const name of ['unregistered.md', 'pristine.md']) {
        const output = await invoke(tool, { path: name }); assert.equal(success(output).collaboration, undefined); assert(text(output).includes(`Physical bytes: ${name}`));
      }
      assert.deepEqual(await h.snapshot(), before);
    });
    await check('physical binary PDF size and complete-hash text-pagination guards remain enforced', async () => {
      await fs.writeFile(path.join(h.workspaceRoot, 'binary.payload'), Buffer.from([0, 1, 2, 0, 255]));
      const { PDF_MAX_IN_MEMORY_BYTES } = await import('../app/lib/pi/tool-runtime-helpers');
      const handle = await fs.open(path.join(h.workspaceRoot, 'oversized.pdf'), 'w');
      try { await handle.truncate(PDF_MAX_IN_MEMORY_BYTES + 1); } finally { await handle.close(); }
      const before = await h.snapshot();
      for (const name of ['binary.payload', 'oversized.pdf']) await denied(() => invoke(tool, { path: name }), document.text);
      const details = success(await invoke(tool, { path: document.filePath, offset: 5, maxChars: 16 }));
      assert.equal(details.offset, 5); assert.equal(details.truncated, true); assert.equal(details.nextOffset, 21);
      assert.equal(details.sha256, crypto.createHash('sha256').update(document.text).digest('hex')); assert.deepEqual(await h.snapshot(), before);
    });
    await check('missing or corrupt initialized state fails closed without physical fallback or implicit repair', async () => {
      for (const fault of ['missing', 'corrupt'] as const) {
        const target = await h.seed({ filePath: `${fault}.md`, text: 'Native authority must never be reinitialized.' });
        const poison = `POISON PHYSICAL FALLBACK ${fault}`; await fs.writeFile(path.join(h.workspaceRoot, target.filePath), poison);
        if (fault === 'missing') await h.admin.query('DELETE FROM collaboration_yjs_states WHERE document_id=$1', [target.documentId]);
        else await h.admin.query('UPDATE collaboration_yjs_states SET yjs_state=$2 WHERE document_id=$1', [target.documentId, Buffer.from([255, 255, 255])]);
        const before = await h.snapshot(); await denied(() => invoke(tool, { path: target.filePath }), poison);
        assert.deepEqual(await h.snapshot(), before); assert.equal(await fs.readFile(path.join(h.workspaceRoot, target.filePath), 'utf8'), poison);
      }
    });
    await check('protected path alias and genuine-invocation guards preserve read boundaries and explicit hidden/session-temp reads', async () => {
      const context = await resolveAgentExecutionContextForSession({ userId: 'reader', sessionId: h.piSessionId, agentId: h.agentId });
      const raw = piTools.find(value => value.name === 'read'); assert(raw && raw !== tool);
      const temporary = resolveAgentRuntimeTempDir(context); await fs.mkdir(temporary, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(temporary, 'temporary.txt'), 'Authorized session temporary file.');
      const auxiliary = await invoke(tool, { path: path.join(temporary, 'temporary.txt') }); success(auxiliary); assert(text(auxiliary).includes('Authorized session temporary file.'));
      await fs.writeFile(path.join(h.workspaceRoot, '.hidden.txt'), 'HIDDEN DATA');
      const hidden = await invoke(tool, { path: '.hidden.txt' }); success(hidden); assert(text(hidden).includes('HIDDEN DATA'));
      const protectedPath = path.join(h.dataRoot, 'secrets', 'private.txt');
      await fs.mkdir(path.dirname(protectedPath), { recursive: true }); await fs.writeFile(protectedPath, 'PROTECTED DATA');
      await fs.symlink(path.join(h.workspaceRoot, 'unregistered.md'), path.join(h.workspaceRoot, 'internal-alias.md')); const before = await h.snapshot();
      try {
        stage = 'protected_path';
        await denied(() => invoke(tool, { path: protectedPath }), 'PROTECTED DATA');
        stage = 'foreign_root';
        await denied(() => invoke(tool, { path: h.dataRoot }), document.text);
        stage = 'internal_alias';
        await denied(() => invoke(tool, { path: 'internal-alias.md' }), 'Physical bytes: unregistered.md');
        stage = 'raw_context_without_invocation';
        await denied(() => runWithAgentExecutionContext(context, () => invoke(raw, { path: document.filePath })), document.text);
        assert.deepEqual(await h.snapshot(), before);
      } finally { await fs.unlink(path.join(h.workspaceRoot, 'internal-alias.md')); }
    });
    await check('current user revocation after tool construction denies content', async () => {
      const before = await h.snapshot(); await h.admin.query('UPDATE "user" SET banned=1 WHERE id=$1', ['reader']);
      try { await denied(() => invoke(tool, { path: document.filePath }), document.text); assert.deepEqual(await h.snapshot(), before); }
      finally { await h.admin.query('UPDATE "user" SET banned=0 WHERE id=$1', ['reader']); }
      assert(text(await invoke(tool, { path: document.filePath })).includes(document.text));
    });
    await check('revocation after actual native bytes load is checked again before disclosure', async () => {
      const original = Client.prototype.query; let armed = true, observed = false; const before = await h.snapshot();
      Client.prototype.query = (function(this: Client, ...args: unknown[]) {
        const pending = Reflect.apply(original, this, args);
        if (this === h.admin || !pending || typeof pending.then !== 'function') return pending;
        return pending.then(async (result: { rows?: Row[] }) => {
          if (armed && result.rows?.some(row => row.document_id === document.documentId && Buffer.isBuffer(row.yjs_state))) {
            armed = false; observed = true; await h.admin.query('UPDATE "user" SET banned=1 WHERE id=$1', ['reader']);
          }
          return result;
        });
      }) as typeof original;
      try { await denied(() => invoke(tool, { path: document.filePath }), document.text); assert.equal(observed, true);
        assert.equal(armed, false); assert.deepEqual(await h.snapshot(), before); }
      finally { Client.prototype.query = original; await h.admin.query('UPDATE "user" SET banned=0 WHERE id=$1', ['reader']); }
      assert(text(await invoke(tool, { path: document.filePath })).includes(document.text));
    });
    await check('path Read identity leads to actual read_document version edit_file V1 and current path Read', async () => {
      await h.admin.query(`UPDATE organization_user_permissions SET can_write_team_workspace=1
        WHERE organization_id='tool-dispatch-org' AND user_id='reader' AND status='active'`);
      await h.setPiEnabledTools(['read', 'read_document', 'edit_file']);
      const tools = await getPiTools('reader', h.agentId, h.piSessionId, { strictAuthorization: true, metadataOnlyExternal: true });
      const currentRead = tools.find(value => value.name === 'read'), nativeRead = tools.find(value => value.name === 'read_document');
      const edit = tools.find(value => value.name === 'edit_file'); assert(currentRead && nativeRead && edit);
      const schema = String((await h.admin.query('SELECT current_schema() AS value')).rows[0].value); assert.match(schema, /^document_tool_dispatch_[a-f0-9]+$/u);
      const applicationName = String((await h.admin.query("SELECT current_setting('application_name') AS value")).rows[0].value);
      await withNativeApiKeyEditRuntime({ schema, applicationName }, async () => {
        const documentId = object(success(await invoke(currentRead, { path: document.filePath })).collaboration).documentId;
        assert.equal(documentId, document.documentId);
        const before = success(await invoke(nativeRead, { workspaceId: h.workspaceId, documentId, format: 'text' }));
        const version = object(before.document).version; assert.equal(typeof version, 'string'); assert.match(version as string, /^canvas-document-v1:[a-f0-9]{64}$/u);
        const result = success(await invoke(edit, { apiVersion: 1, action: 'edit', workspaceId: h.workspaceId,
          documentId, expectedVersion: version, idempotencyKey: 'native-path-read-edit-001',
          patch: { kind: 'native_text_replace', edits: [{ oldText: 'Authoritative', newText: 'Edited authoritative' }] } }));
        assert.equal(result.state, 'confirmed'); assert.equal(object(result.effect).beforeVersion, version);
        const afterEdit = await h.snapshot(), after = await invoke(currentRead, { path: document.filePath }); success(after);
        assert(text(after).includes(document.text.replace('Authoritative', 'Edited authoritative')));
        assert.equal(object(success(after).collaboration).documentId, documentId); assert.deepEqual(await h.snapshot(), afterEdit);
        const nativeAfter = success(await invoke(nativeRead, { workspaceId: h.workspaceId, documentId, format: 'text' }));
        assert.equal(object(nativeAfter.document).version, object(result.effect).afterVersion);
      });
    });
    complete = true;
    console.log(JSON.stringify({ suite: 'agent-native-path-read', passed: true, groups, actualRegistryAndInvocation: true,
      nativeReadsPreserveRowsAndProjection: true, corruptStateFallsBackToDisk: false, actualReadEditRead: true,
      actualRevocationAfterNativeBytes: true }));
  });
}
main().catch(error => { process.exitCode = 1;
  const assertion = error instanceof assert.AssertionError ? { operator: error.operator,
    actual: typeof error.actual === 'boolean' || error.actual === null ? error.actual : typeof error.actual,
    expected: typeof error.expected === 'boolean' || error.expected === null ? error.expected : typeof error.expected } : undefined;
  console.error(JSON.stringify({ suite: 'agent-native-path-read', stage, error: error instanceof Error ? error.name : 'UnknownError', assertion })); });
