import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';

import * as sdk from '@modelcontextprotocol/server';
import ts from 'typescript';

import * as validation from '../app/lib/mcp/server/ingest-validation';
import { DirectMcpIngestDownloadError } from '../app/lib/mcp/server/ingest-download';
import type { DirectMcpFileReference } from '../app/lib/mcp/server/ingest-download';
import type { DirectMcpAccessPrincipal } from '../app/lib/mcp/server/access-token-verifier';
import type { DirectMcpFileReceipt } from '../app/lib/mcp/server/file-ingest';
import type { DirectMcpToolDescriptor } from '../app/lib/mcp/server/tool-descriptor';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const requireDependency = createRequire(import.meta.url);
type ModuleExports = Record<string, unknown>;

/** Evaluate complete production modules while substituting their IO boundary. */
function loadModule(fileName: string, dependencies: Record<string, unknown>): ModuleExports {
  const filename = path.resolve(fileName);
  const source = readFileSync(filename, 'utf8');
  const javascript = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const evaluatedModule = { exports: {} as ModuleExports };
  const load = (name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : requireDependency(name);
  new Function('require', 'module', 'exports', javascript)(load, evaluatedModule, evaluatedModule.exports);
  return evaluatedModule.exports;
}

type IngestInput = {
  principal: DirectMcpAccessPrincipal;
  workspace: WorkspaceContext;
  path: string;
  idempotencyKey: string;
  fingerprint: string;
  signal?: AbortSignal;
  loadContent(): Promise<{ content: Buffer; validation: validation.DirectMcpIngestContentValidation }>;
  verifyAuthority(): Promise<void>;
};
type Authority = { principal: DirectMcpAccessPrincipal; workspace: WorkspaceContext; verifyAuthority(): Promise<void> };
type ToolExports = {
  getDirectMcpIngestToolDefinitions(): Array<{ id: string; descriptor: DirectMcpToolDescriptor;
    execute(args: unknown, auth?: sdk.AuthInfo, signal?: AbortSignal): Promise<sdk.CallToolResult> }>;
  getDirectMcpIngestToolDescriptor(id: 'create_knowledge_source' | 'import_knowledge_file'): DirectMcpToolDescriptor;
  executeDirectMcpIngestTool(id: 'create_knowledge_source' | 'import_knowledge_file', args: unknown, auth?: sdk.AuthInfo, signal?: AbortSignal): Promise<sdk.CallToolResult>;
};

function fixture() {
  const state = {
    enabled: true,
    tools: ['create_knowledge_source', 'import_knowledge_file'],
    canRead: true,
    canWrite: true,
    canRunAgent: true,
    status: 'active' as WorkspaceContext['status'],
    allowed: true,
    workspaceEnabled: true,
    workspacePresent: true,
    rootPath: '/synthetic/workspace',
    userId: 'user-1',
    clientId: 'client-1',
    sessionId: 'session-1',
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    authError: null as null | 'invalid_token' | 'insufficient_scope',
    verificationCalls: 0,
    downloadCalls: [] as DirectMcpFileReference[],
    downloadSignals: [] as Array<AbortSignal | undefined>,
    ingestCalls: [] as IngestInput[],
    fingerprintInputs: [] as unknown[],
    imported: [] as Buffer[],
    downloadedContent: Buffer.from('# Original\n'),
    afterContentLoaded: null as null | (() => void),
    downloadError: null as null | Error,
  };
  const oauthConfig = { resolveDirectMcpOAuthConfig: () => ({
    issuer: 'https://canvas.fixture.test', protectedResourceMetadataUrl: 'https://canvas.fixture.test/.well-known/oauth-protected-resource',
  }) };
  const access = loadModule('app/lib/mcp/server/access-token-verifier.ts', {
    'server-only': {}, 'better-auth/oauth2': {}, '@/app/lib/auth': {}, '@/app/lib/db': {},
    '@/app/lib/license/seat-limit': {}, '@/app/lib/mcp/server/config': oauthConfig,
    '@/app/lib/mcp/server/client-name': {},
  });
  const AuthorizationError = access.DirectMcpAuthorizationError as new (
    code: string, status: number, message: string, options?: { challengeError?: string; scope?: string },
  ) => Error;
  const verifier = { DirectMcpAuthorizationError: AuthorizationError,
    verifyDirectMcpAccessToken: async (token: string, scopes: string[]) => {
      state.verificationCalls++;
      assert.equal(token, 'fixture-bearer');
      assert.deepEqual(scopes, ['knowledge:write']);
      if (state.authError) throw new AuthorizationError(state.authError, state.authError === 'insufficient_scope' ? 403 : 401,
        'Private verifier diagnostic', { challengeError: state.authError, scope: 'knowledge:write' });
      return {
        userId: state.userId, subject: state.userId, clientId: state.clientId, clientName: 'Fixture client',
        sessionId: state.sessionId, expiresAt: state.expiresAt, issuedAt: Math.floor(Date.now() / 1000),
        issuer: 'https://canvas.fixture.test', audience: 'https://canvas.fixture.test/api/mcp',
        scopes: ['knowledge:write'], payload: {},
      } satisfies DirectMcpAccessPrincipal;
    },
  };
  const workspace = (): WorkspaceContext => ({
    workspaceId: 'workspace-1', workspaceType: 'personal', rootPath: state.rootPath,
    status: state.status, ownerUserId: state.userId, legacy: false,
    permissions: { canRead: state.canRead, canWrite: state.canWrite, canRunAgent: state.canRunAgent,
      canDelete: true, canCreatePublicLinks: false, canManageWorkspace: true },
  });
  const workspacePolicy = loadModule('app/lib/mcp/server/workspace-access-policy.ts', {
    'server-only': {}, '@/app/lib/db': {}, '@/app/lib/workspaces/context': {}, '@/app/lib/workspaces/listing-action': {},
  });
  const fileIngest = loadModule('app/lib/mcp/server/file-ingest.ts', {
    'server-only': {}, '@/app/lib/filesystem/workspace-files': {}, '@/app/lib/files/revision-guard': {},
    '@/app/lib/files/collaboration-policy': { readFileCollaborationState: async () => {
      throw new Error('The tool boundary must use its mocked ingestion service.');
    } },
    '@/app/lib/files/workspace-mutation-lock': {}, '@/app/lib/files/write-service': {},
    '@/app/lib/workspaces/path-guard': {
      normalizeWorkspaceRelativePath: (value: string) => path.posix.normalize(value.replaceAll('\\', '/')),
    },
    '@/app/lib/runtime-data-paths': {}, './config': {},
  });
  const fingerprint = fileIngest.directMcpIngestFingerprint as (input: unknown) => string;
  const ingestion = {
    ...fileIngest,
    directMcpIngestFingerprint: (input: unknown) => {
      state.fingerprintInputs.push(input);
      return fingerprint(input);
    },
    createDirectMcpWorkspaceFile: async (input: IngestInput): Promise<DirectMcpFileReceipt> => {
      state.ingestCalls.push(input);
      await input.verifyAuthority();
      const loaded = await input.loadContent();
      state.afterContentLoaded?.();
      await input.verifyAuthority();
      state.imported.push(Buffer.from(loaded.content));
      return {
        status: 'created', workspace_id: input.workspace.workspaceId, path: input.path, size: loaded.content.length,
        sha256: createHash('sha256').update(loaded.content).digest('hex'), mime_type: loaded.validation.mimeType,
        revision_id: 'revision-fixture', operation_id: 'operation-fixture',
        document_url: 'https://canvas.fixture.test/notebook?workspaceId=workspace-1&path=notes%2Fnew.md',
        markdown: loaded.validation.markdown, warnings: loaded.validation.warnings,
      };
    },
  };
  const authority = loadModule('app/lib/mcp/server/ingest-authority.ts', {
    'server-only': {}, './access-token-verifier': verifier, './file-ingest': ingestion,
    './runtime-settings': { getDirectMcpRuntimeSettings: async () => ({ enabled: state.enabled, tools: [...state.tools] }) },
    './workspace-access-policy': {
      isDirectMcpReadableWorkspace: workspacePolicy.isDirectMcpReadableWorkspace,
      loadDirectMcpWorkspaceListingForUser: async (userId: string) => {
        assert.equal(userId, state.userId);
        return { workspaces: state.workspacePresent ? [workspace()] : [] };
      },
      listDirectMcpAllowedWorkspaceIds: async (principal: DirectMcpAccessPrincipal) => {
        assert.equal(principal.clientId, state.clientId);
        return new Set(state.allowed ? ['workspace-1'] : []);
      },
      listDirectMcpEnabledWorkspaceIds: async () => new Set(state.workspaceEnabled ? ['workspace-1'] : []),
    },
  });
  const toolAuth = loadModule('app/lib/mcp/server/tool-auth.ts', {
    'server-only': {}, '@/app/lib/mcp/server/access-token-verifier': verifier,
  });
  const documentContract = loadModule('app/lib/mcp/server/document-edit-contract.ts', {
    'server-only': {}, '@/app/lib/file-version-center/notification-contract': {}, './config': {},
  });
  const tools = loadModule('app/lib/mcp/server/ingest-tools.ts', {
    'server-only': {}, '@modelcontextprotocol/server': sdk, './access-token-verifier': verifier,
    './ingest-authority': authority, './file-ingest': ingestion, './ingest-validation': validation,
    './document-edit-contract': documentContract, './tool-auth': toolAuth,
    './ingest-download': { DirectMcpIngestDownloadError,
      downloadDirectMcpFile: async (file: DirectMcpFileReference, signal?: AbortSignal) => {
        state.downloadCalls.push(file);
        state.downloadSignals.push(signal);
        if (state.downloadError) throw state.downloadError;
        return { content: Buffer.from(state.downloadedContent), mimeType: file.mime_type ?? 'text/markdown' };
      },
    },
  }) as unknown as ToolExports;
  return { state, tools, createAuthority: authority.createDirectMcpIngestAuthority as (
    input: { token: string; tool: 'create_knowledge_source' | 'import_knowledge_file'; workspaceId: string },
  ) => Promise<Authority> };
}

const textArgs = { workspace_id: 'workspace-1', path: 'notes/new.md', idempotency_key: 'fixture-key-1', content: '# Created\n' };
const auth = { token: 'fixture-bearer' } as sdk.AuthInfo;
const fileArgs = { workspace_id: 'workspace-1', path: 'notes/original.md', idempotency_key: 'fixture-key-2',
  file: { download_url: 'https://host.fixture.test/file?token=secret-first', file_id: 'host-file-1', mime_type: 'text/markdown' } };

function structuredContent(result: sdk.CallToolResult): Record<string, unknown> {
  const payload = result.structuredContent;
  assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload));
  return payload as Record<string, unknown>;
}

function errorCode(result: sdk.CallToolResult): unknown {
  assert.equal(result.isError, true);
  return structuredContent(result).code;
}

test('descriptors expose all top-level fields, OAuth scopes and host file metadata', () => {
  const { tools } = fixture();
  assert.deepEqual(tools.getDirectMcpIngestToolDefinitions().map(tool => tool.id), ['create_knowledge_source', 'import_knowledge_file']);
  for (const id of ['create_knowledge_source', 'import_knowledge_file'] as const) {
    const descriptor = tools.getDirectMcpIngestToolDescriptor(id);
    assert.deepEqual(descriptor.securitySchemes, [{ type: 'oauth2', scopes: ['knowledge:write'] }]);
    assert.deepEqual(descriptor._meta.securitySchemes, descriptor.securitySchemes);
    assert.equal(descriptor.inputSchema.type, 'object');
    assert.equal(descriptor.inputSchema.additionalProperties, false);
    const isImport = id === 'import_knowledge_file';
    assert.deepEqual(Object.keys(descriptor.inputSchema.properties ?? {}).sort(),
      ['workspace_id', 'path', 'idempotency_key', isImport ? 'file' : 'content'].sort());
    assert.equal(descriptor.inputSchema.oneOf, undefined);
    assert.deepEqual(descriptor.inputSchema.required, ['workspace_id', 'path', 'idempotency_key', isImport ? 'file' : 'content']);
    assert.equal(descriptor.annotations?.readOnlyHint, false);
    assert.equal(descriptor.annotations?.destructiveHint, false);
    assert.equal(descriptor.annotations?.idempotentHint, true);
    assert.equal(descriptor.annotations?.openWorldHint, isImport);
    if (isImport) {
      assert.deepEqual((descriptor._meta as Record<string, unknown>)['openai/fileParams'], ['file']);
      const fileSchema = descriptor.inputSchema.properties?.file as { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean };
      assert.deepEqual(fileSchema.required, ['download_url', 'file_id']);
      assert.deepEqual(Object.keys(fileSchema.properties).sort(), ['download_url', 'file_id', 'mime_type', 'file_name'].sort());
      assert.equal(fileSchema.additionalProperties, false);
    }
  }
});

test('authentication and additional-scope challenges precede ingestion or download', async () => {
  const { tools, state } = fixture();
  const missing = await tools.executeDirectMcpIngestTool('create_knowledge_source', textArgs);
  assert.equal(missing.isError, true);
  assert.match(JSON.stringify(missing._meta), /invalid_token/u);
  assert.equal(state.verificationCalls, 0);
  state.authError = 'insufficient_scope';
  const insufficient = await tools.executeDirectMcpIngestTool('import_knowledge_file', fileArgs, auth);
  assert.equal(insufficient.isError, true);
  assert.match(JSON.stringify(insufficient._meta), /insufficient_scope/u);
  assert.match(JSON.stringify(insufficient.content), /knowledge:write/u);
  assert.doesNotMatch(JSON.stringify(insufficient), /Private verifier/u);
  assert.equal(state.ingestCalls.length, 0);
  assert.equal(state.downloadCalls.length, 0);
});

test('disabled capabilities, revoked grants and workspace permissions block imports', async () => {
  const scenarios: Array<[string, (state: ReturnType<typeof fixture>['state']) => void, string]> = [
    ['instance disabled', state => { state.enabled = false; }, 'MCP_INGEST_NOT_ENABLED'],
    ['tool disabled', state => { state.tools = ['create_knowledge_source']; }, 'MCP_INGEST_NOT_ENABLED'],
    ['grant revoked', state => { state.allowed = false; }, 'MCP_INGEST_AUTHORITY_CHANGED'],
    ['workspace disabled', state => { state.workspaceEnabled = false; }, 'MCP_INGEST_AUTHORITY_CHANGED'],
    ['workspace missing', state => { state.workspacePresent = false; }, 'MCP_INGEST_AUTHORITY_CHANGED'],
    ['cannot write', state => { state.canWrite = false; }, 'MCP_INGEST_AUTHORITY_CHANGED'],
    ['cannot run agent', state => { state.canRunAgent = false; }, 'MCP_INGEST_AUTHORITY_CHANGED'],
    ['cannot read', state => { state.canRead = false; }, 'MCP_INGEST_AUTHORITY_CHANGED'],
    ['workspace archived', state => { state.status = 'archived'; }, 'MCP_INGEST_AUTHORITY_CHANGED'],
    ['token expired', state => { state.expiresAt = Math.floor(Date.now() / 1000) - 1; }, 'MCP_INGEST_AUTHORITY_CHANGED'],
  ];
  for (const [name, change, code] of scenarios) {
    const { state, tools } = fixture();
    change(state);
    assert.equal(errorCode(await tools.executeDirectMcpIngestTool('import_knowledge_file', fileArgs, auth)), code, name);
    assert.equal(state.ingestCalls.length, 0, name);
    assert.equal(state.downloadCalls.length, 0, name);
  }
  const revoked = fixture();
  revoked.state.authError = 'invalid_token';
  const result = await revoked.tools.executeDirectMcpIngestTool('create_knowledge_source', textArgs, auth);
  assert.match(JSON.stringify(result._meta), /invalid_token/u);
  assert.equal(revoked.state.ingestCalls.length, 0);
});

test('publication authority revalidates roots, sessions, expiry and grants after initial access', async () => {
  const changes: Array<(state: ReturnType<typeof fixture>['state']) => void> = [
    state => { state.rootPath = '/different/root'; }, state => { state.sessionId = 'session-2'; },
    state => { state.clientId = 'client-2'; }, state => { state.userId = 'user-2'; },
    state => { state.allowed = false; }, state => { state.canWrite = false; },
    state => { state.canRunAgent = false; }, state => { state.expiresAt = Math.floor(Date.now() / 1000) - 1; },
  ];
  for (const change of changes) {
    const { createAuthority, state } = fixture();
    const authority = await createAuthority({ token: 'fixture-bearer', tool: 'create_knowledge_source', workspaceId: 'workspace-1' });
    change(state);
    await assert.rejects(authority.verifyAuthority(), /workspace or connection no longer permits/u);
    assert.equal(state.verificationCalls, 2);
  }
});

test('complete generated content and empty text retain whitespace through the boundary', async () => {
  const { tools, state } = fixture();
  for (const content of ['\n  Text\r\n\r\n', '']) {
    const result = await tools.executeDirectMcpIngestTool('create_knowledge_source', { ...textArgs, path: 'notes/plain.txt', content }, auth);
    assert.equal(result.isError, undefined);
    assert.equal(structuredContent(result).size, Buffer.byteLength(content));
    assert.equal(state.imported.at(-1)?.toString('utf8'), content);
  }
  assert.equal(state.downloadCalls.length, 0);
  assert.ok(state.verificationCalls >= 6, 'authority is checked at initial access and both publication fences');
});

test('host IDs bind retries while refreshed URLs are excluded from persisted fingerprints', async () => {
  const { tools, state } = fixture();
  const first = await tools.executeDirectMcpIngestTool('import_knowledge_file', fileArgs, auth);
  const second = await tools.executeDirectMcpIngestTool('import_knowledge_file', { ...fileArgs,
    file: { ...fileArgs.file, download_url: 'https://new-host.fixture.test/file?token=secret-second' } }, auth);
  assert.equal(first.isError, undefined);
  assert.equal(second.isError, undefined);
  assert.equal(state.ingestCalls[0].fingerprint, state.ingestCalls[1].fingerprint);
  assert.doesNotMatch(JSON.stringify(state.fingerprintInputs), /https:|token=|secret-first|secret-second/u);
  assert.doesNotMatch(JSON.stringify(state.ingestCalls), /fixture-bearer|secret-first|secret-second|download_url/u);
  assert.equal(state.downloadCalls[0].file_id, 'host-file-1');
  await tools.executeDirectMcpIngestTool('import_knowledge_file', { ...fileArgs, file: { ...fileArgs.file, file_id: 'host-file-2' } }, auth);
  assert.notEqual(state.ingestCalls[0].fingerprint, state.ingestCalls[2].fingerprint);
});

test('revocation during content loading and validation failures do not publish bytes', async () => {
  const revoked = fixture();
  revoked.state.afterContentLoaded = () => { revoked.state.allowed = false; };
  assert.equal(errorCode(await revoked.tools.executeDirectMcpIngestTool('import_knowledge_file', fileArgs, auth)), 'MCP_INGEST_AUTHORITY_CHANGED');
  assert.equal(revoked.state.imported.length, 0);
  const malformed = fixture();
  const invalid = await malformed.tools.executeDirectMcpIngestTool('create_knowledge_source', { ...textArgs, content: '---\ntitle: [\n---\nBody' }, auth);
  assert.equal(errorCode(invalid), 'invalid_frontmatter');
  assert.equal(malformed.state.imported.length, 0);
  const original = fixture();
  original.state.downloadedContent = Buffer.from('\uFEFF---\r\ntitle: [\r\n---\r\nBody\r\n');
  const imported = await original.tools.executeDirectMcpIngestTool('import_knowledge_file', fileArgs, auth);
  assert.equal(imported.isError, undefined);
  assert.deepEqual(original.state.imported[0], original.state.downloadedContent);
  assert.ok((structuredContent(imported).warnings as Array<{ code: string }>).some(warning => warning.code === 'invalid_frontmatter'));
});

test('malformed tool arguments fail before authority, storage or network', async () => {
  const { tools, state } = fixture();
  for (const args of [null, [], { ...textArgs, workspace_id: 42 }, { ...textArgs, path: '' },
    { ...textArgs, idempotency_key: 'short' }, { ...textArgs, content: undefined }, { ...textArgs, path: 'image.png' }]) {
    await assert.rejects(tools.executeDirectMcpIngestTool('create_knowledge_source', args, auth));
  }
  for (const file of [null, { download_url: 'https://host.fixture.test/file' },
    { ...fileArgs.file, file_id: '' }, { ...fileArgs.file, mime_type: 42 }]) {
    await assert.rejects(tools.executeDirectMcpIngestTool('import_knowledge_file', { ...fileArgs, file }, auth));
  }
  assert.equal(state.verificationCalls, 0);
  assert.equal(state.ingestCalls.length, 0);
  assert.equal(state.downloadCalls.length, 0);
});

test('runtime rejects fields forbidden by its published input schemas', async () => {
  const { tools, state } = fixture();
  await assert.rejects(tools.executeDirectMcpIngestTool('create_knowledge_source', { ...textArgs, overwrite: true }, auth));
  await assert.rejects(tools.executeDirectMcpIngestTool('import_knowledge_file', { ...fileArgs,
    file: { ...fileArgs.file, authorization: 'Do not forward this' } }, auth));
  assert.equal(state.verificationCalls, 0);
  assert.equal(state.downloadCalls.length, 0);
});

test('tool definitions forward the MCP cancellation signal to download and publication', async () => {
  const active = fixture();
  const cancellation = new AbortController();
  const definition = active.tools.getDirectMcpIngestToolDefinitions().find(tool => tool.id === 'import_knowledge_file');
  assert.ok(definition);
  const result = await definition.execute(fileArgs, auth, cancellation.signal);
  assert.equal(result.isError, undefined);
  assert.equal(active.state.ingestCalls[0].signal, cancellation.signal);
  assert.equal(active.state.downloadSignals[0], cancellation.signal);

  const aborted = fixture();
  cancellation.abort(new Error('Sensitive cancellation detail token=hidden'));
  const cancelled = await aborted.tools.executeDirectMcpIngestTool('import_knowledge_file', fileArgs, auth, cancellation.signal);
  assert.equal(cancelled.isError, true);
  assert.equal(aborted.state.imported.length, 0);
  assert.equal(aborted.state.downloadCalls.length, 0);
  assert.doesNotMatch(JSON.stringify(cancelled), /Sensitive|token=|hidden/u);
});
