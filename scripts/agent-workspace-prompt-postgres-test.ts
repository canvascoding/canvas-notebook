import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Client } from 'pg';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';
let stage = 'setup', groups = 0, complete = false;
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });
async function main() {
  await withDocumentReadToolDispatchFixture(async h => {
    const { buildWorkspaceFileTreePrompt, WORKSPACE_FILE_TREE_MAX_PROMPT_BYTES } = await import('../app/lib/agents/workspace-file-tree-context');
    const { readAgentWorkspaceForPrompt, readCurrentPromptWorkspaceForUser } = await import('../app/lib/agents/workspace-file-tree-authorization');
    const { resolveAgentExecutionContextForSession } = await import('../app/lib/pi/session-workspace-context');
    const context = await resolveAgentExecutionContextForSession({ userId: 'reader', sessionId: h.piSessionId, agentId: h.agentId });
    const scope = { workspaceId: h.workspaceId, rootPath: h.workspaceRoot };
    const read = () => buildWorkspaceFileTreePrompt(scope, () => readAgentWorkspaceForPrompt(context));
    const unavailable = (value: Awaited<ReturnType<typeof read>>) => {
      assert(value.promptBlock.includes('is unavailable for this model turn'));
      assert.equal(value.promptBlock.includes('native-prompt-only.md'), false); assert(value.diagnostics.unavailableDirectories > 0);
    };
    const check = async (name: string, operation: () => Promise<void>) => {
      stage = name; await operation(); groups++; console.log(JSON.stringify({ suite: 'agent-native-workspace-prompt-group', name, passed: true }));
    };
    const target = await h.seed({ filePath: 'logical/native-prompt-only.md', text: 'Native prompt fixture.' });
    await check('actual stored PI source reads native-only paths without changing domain rows or creating projections', async () => {
      await assert.rejects(fs.stat(path.join(h.workspaceRoot, target.filePath)), { code: 'ENOENT' });
      const before = await h.snapshot(), result = await read(); assert(result.promptBlock.includes('native-prompt-only.md'));
      assert.equal(result.diagnostics.unavailableDirectories, 0); assert.deepEqual(await h.snapshot(), before);
      await assert.rejects(fs.stat(path.join(h.workspaceRoot, target.filePath)), { code: 'ENOENT' });
    });
    await check('mixed logical and physical namespace preserves bounded breadth depth escaping hidden entries and one shared catalogue capture', async () => {
      for (let i = 0; i < 45; i++) {
        await h.seed({ filePath: `root-${String(i).padStart(2, '0')}/native.md`, text: `Native ${i}` });
        await fs.writeFile(path.join(h.workspaceRoot, `physical-${String(i).padStart(2, '0')}.txt`), `Physical ${i}`);
      }
      await h.seed({ filePath: 'deep/a/b/c/d/native-too-deep.md', text: 'Beyond prompt depth.' });
      await h.seed({ filePath: 'unsafe<dir>/café.md', text: 'Escaped directory name.' });
      await h.seed({ filePath: '.hidden-native.md', text: 'Hidden native name.' });
      await fs.writeFile(path.join(h.workspaceRoot, '.hidden.txt'), 'Hidden physical name.');
      const before = await h.snapshot(), original = Client.prototype.query; const statements: string[] = [];
      Client.prototype.query = (function(this: Client, ...args: unknown[]) {
        if (this !== h.admin) {
          const first = args[0], sql = typeof first === 'string' ? first : first && typeof first === 'object' ? Reflect.get(first, 'text') : undefined;
          if (typeof sql === 'string') statements.push(sql);
        }
        return Reflect.apply(original, this, args);
      }) as typeof original;
      let result: Awaited<ReturnType<typeof read>>;
      try { result = await read(); } finally { Client.prototype.query = original; }
      for (let i = 0; i < 45; i++) assert(result.promptBlock.includes(`root-${String(i).padStart(2, '0')}/`));
      assert(result.promptBlock.includes('physical-')); assert(result.promptBlock.includes('unsafe\\u003cdir\\u003e/'));
      assert.equal(/\.hidden|native-too-deep\.md/u.test(result.promptBlock), false);
      assert(result.diagnostics.truncatedByEntryLimit); assert(Buffer.byteLength(result.promptBlock, 'utf8') <= WORKSPACE_FILE_TREE_MAX_PROMPT_BYTES);
      assert.equal(statements.filter(sql => sql.includes('pg_advisory_xact_lock_shared')).length, 1);
      assert.equal(statements.filter(sql => sql.includes('FROM collaboration_documents d LEFT JOIN collaboration_yjs_states')).length, 2);
      assert.equal(statements.some(sql => /FROM\s+workspace_file_metadata/iu.test(sql)), false);
      assert.deepEqual(await h.snapshot(), before);
      const nativeDocuments = Number((await h.admin.query('SELECT count(*)::int AS n FROM collaboration_documents WHERE workspace_id=$1', [h.workspaceId])).rows[0].n);
      console.log(JSON.stringify({ suite: 'agent-native-workspace-prompt-sql', nativeDocuments,
        displayedRootDirectories: result.diagnostics.displayedRootDirectories, allStatements: statements.length,
        nativeScopeCaptures: 1, nativeCatalogueSelects: 2, fileMetadataEnrichmentSelects: 0 }));
    });
    await check('real user ban and forged user or workspace selectors deny the entire prompt', async () => {
      const before = await h.snapshot(); await h.admin.query('UPDATE "user" SET banned=1 WHERE id=$1', ['reader']);
      stage = 'user_banned_before_prompt';
      try { unavailable(await read()); } finally { await h.admin.query('UPDATE "user" SET banned=0 WHERE id=$1', ['reader']); }
      for (const selected of [{ ...context, userId: 'owner' }, { ...context, workspaceId: 'foreign-workspace' }]) {
        stage = selected.userId !== context.userId ? 'forged_user_selector' : 'forged_workspace_selector';
        unavailable(await buildWorkspaceFileTreePrompt(scope, () => readAgentWorkspaceForPrompt(selected)));
      }
      stage = 'mismatched_root';
      unavailable(await buildWorkspaceFileTreePrompt({ ...scope, rootPath: h.dataRoot }, () => readAgentWorkspaceForPrompt(context)));
      assert.deepEqual(await h.snapshot(), before); assert((await read()).promptBlock.includes('native-prompt-only.md'));
    });
    await check('native and physical name conflicts deny the prompt without a physical fallback or state repair', async () => {
      await fs.writeFile(path.join(h.workspaceRoot, 'logical'), 'A physical file conflicting with a logical native directory.');
      const before = await h.snapshot();
      try { unavailable(await read()); assert.deepEqual(await h.snapshot(), before); }
      finally { await fs.unlink(path.join(h.workspaceRoot, 'logical')); }
    });
    for (const fault of ['user-ban', 'parent-session-archived'] as const) {
      await check(`actual ${fault} after native producer directory bytes prevents prepared prompt disclosure`, async () => {
        const original = fs.readdir; let armed = true, observed = false, mutated = false; const before = await h.snapshot();
        fs.readdir = (async (...args: Parameters<typeof fs.readdir>) => {
          const result = await Reflect.apply(original, fs, args);
          if (armed && String(args[0]) === h.workspaceRoot && /buildFileTree/u.test(new Error().stack ?? '')) {
            armed = false; observed = true;
            if (fault === 'user-ban') {
              const changed = await h.admin.query('UPDATE "user" SET banned=1 WHERE id=$1 RETURNING banned', ['reader']);
              assert.equal(Number(changed.rows[0]?.banned), 1);
            } else {
              const at = Date.now(), changed = await h.admin.query('UPDATE pi_sessions SET archived_at=$2 WHERE session_id=$1 RETURNING archived_at', [h.piSessionId, at]);
              assert.equal(Number(changed.rows[0]?.archived_at), at);
            }
            mutated = true;
          }
          return result;
        }) as typeof fs.readdir;
        try { unavailable(await read()); assert.equal(observed, true); assert.equal(mutated, true); assert.equal(armed, false); assert.deepEqual(await h.snapshot(), before); }
        finally { fs.readdir = original;
          await h.admin.query('UPDATE "user" SET banned=0 WHERE id=$1', ['reader']);
          await h.admin.query('UPDATE pi_sessions SET archived_at=NULL WHERE session_id=$1', [h.piSessionId]); }
        assert((await read()).promptBlock.includes('native-prompt-only.md'));
      });
    }
    await check('actual persisted automation owner policy reads native names and current workspace permission revocation denies them', async () => {
      await h.admin.query(`UPDATE organization_user_permissions SET can_write_team_workspace=1
        WHERE organization_id='tool-dispatch-org' AND user_id='reader' AND status='active'`);
      const jobId = `prompt-job-${crypto.randomUUID()}`;
      const row = (await h.admin.query(`INSERT INTO automation_jobs(id,name,status,scope,job_scope,organization_id,workspace_id,
        workspace_type,owner_user_id,responsible_user_id,prompt,preferred_skill,workspace_context_paths_json,schedule_kind,
        schedule_config_json,time_zone,created_by_user_id,agent_id,created_at,updated_at,trigger_kind)
        VALUES($1,'Owned prompt fixture','paused','organization','organization:tool-dispatch-org','tool-dispatch-org',$2,
          'organization','reader','reader','No execution','none','[]','daily','{"kind":"daily","times":["09:00"],"timeZone":"UTC"}','UTC','reader',$3,$4,$4,'manual')
        RETURNING id`, [jobId, h.workspaceId, h.agentId, Date.now()])).rows[0];
      assert.equal(row?.id, jobId); const { resolveAutomationRunWorkspace } = await import('../app/lib/automations/policy');
      const { getAutomationJob } = await import('../app/lib/automations/store');
      const job = await getAutomationJob(jobId); assert(job); assert.equal(job.integrityStatus, 'valid');
      const owner = job.responsibleUserId || job.ownerUserId || job.createdByUserId;
      const readJob = () => buildWorkspaceFileTreePrompt(scope, () =>
        readCurrentPromptWorkspaceForUser(owner, () => resolveAutomationRunWorkspace(job)));
      const before = await h.snapshot(); assert((await readJob()).promptBlock.includes('native-prompt-only.md'));
      await h.admin.query('UPDATE "user" SET banned=1 WHERE id=$1', ['reader']);
      try { unavailable(await readJob()); } finally { await h.admin.query('UPDATE "user" SET banned=0 WHERE id=$1', ['reader']); }
      await h.admin.query(`UPDATE organization_user_permissions SET can_write_team_workspace=0
        WHERE organization_id='tool-dispatch-org' AND user_id='reader'`);
      try { unavailable(await readJob()); assert.deepEqual(await h.snapshot(), before); }
      finally { await h.admin.query(`UPDATE organization_user_permissions SET can_write_team_workspace=1
        WHERE organization_id='tool-dispatch-org' AND user_id='reader'`); }
    });
    complete = true; console.log(JSON.stringify({ suite: 'agent-native-workspace-prompt', passed: true, groups,
      genuineStoredSession: true, persistedAutomationOwnerPolicy: true, oneNativeCatalogueScope: true,
      metadataEnrichmentQueries: 0, nativeRowsAndProjectionUnchanged: true, providerCalls: 0,
      actualModelOrAutomationRunAcceptance: false }));
  });
}
main().catch(error => { process.exitCode = 1;
  const assertion = error instanceof assert.AssertionError ? { operator: error.operator,
    actual: typeof error.actual === 'boolean' || error.actual === null ? error.actual : typeof error.actual,
    expected: typeof error.expected === 'boolean' || error.expected === null ? error.expected : typeof error.expected } : undefined;
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    && /^[A-Z0-9_]{1,80}$/u.test(error.code) ? error.code : undefined;
  console.error(JSON.stringify({ suite: 'agent-native-workspace-prompt', stage, error: error instanceof Error ? error.name : 'UnknownError', code, assertion })); });
