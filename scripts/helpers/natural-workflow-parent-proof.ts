import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import type { IntegrationBrowserProviderCalls } from '../fixtures/integration-tool-browser-provider';
import type { NaturalWorkflowSessionModel } from '../../tests/helpers/natural-workflow-model-setup';
import type { IntegrationProviderDescriptor } from '../../app/lib/integration-tools/contracts';

type Pin = { resourceRef: string; publishedRevisionRef: string; checksum: string; version: string };
type Run = { actorId: string; actorHash: string; authSessionHash: string; sessionId: string; sessionHash: string;
  agentId: string; workspaceId: string; label: string; query: string; scratchHash: string; transcriptSHA: string;
  scriptCallIdHash: string; scriptRefHash: string; package: Pin;
  selectedBindings: Array<{ alias: string; toolRefHash: string; schemaRefHash: string }>;
  effects: Array<{ source: string; toolName: string; toolCallIdHash: string; connectionRef: string }>;
  skillReads: Array<{ toolCallIdHash: string; bodySHA: string; byteLength: number; relativePath: string }>;
  providerExecutions: IntegrationBrowserProviderCalls['executions']; runtimeHash: string };
type BrowserProof = { version: number; nonce: string; actorId: string; actorIds: string[]; phase: string; outstanding: unknown;
  closedContexts: boolean; authClosed: boolean; normalSessionNull: string[]; agentIds: string[]; workspaceIds: string[];
  connectionRefs: string[]; publications: Pin[]; runs: Run[]; evidence: Array<{ relative: string; sha256: string }>;
  provider: IntegrationBrowserProviderCalls; sharedAccountHash: string; sharedProfileEntityHash: string;
  sourceHashes: Record<string, string>;
  model: { installationId: string; providerId: string; modelId: string; credentialScope: string; status: string; verificationCode: string };
  domainCleanup: string; failure?: unknown };

const naturalWorkflowHash = (value: string) => createHash('sha256').update(value).digest('hex');

type NativeReadMessage = { role: string; content?: string | Array<{ type?: string; name?: string; id?: string;
  text?: string; arguments?: unknown }>; toolName?: string; toolCallId?: string; isError?: boolean;
  details?: Record<string, unknown> };
type TranscriptBindingProof = { source: 'mcp' | 'composio'; providerRef: string; toolRefHash: string;
  schemaRefHash: string; inputSchemaHash: string; toolCallIdHash: string; connectionRef: string };
const nativeSkillRelativePath = 'skills/design-research/SKILL.md';
const naturalProofByteLimit = 2 * 1024 * 1024;

/** The private published path is used only to read immutable bytes, never as evidence of model arguments. */
async function readNaturalWorkflowProofBytes(filePath: string, mode: number): Promise<Buffer> {
  const file = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    assert(before.isFile() && before.nlink === 1 && before.uid === process.getuid?.()
      && (before.mode & 0o777) === mode && before.size > 0 && before.size <= naturalProofByteLimit);
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      assert(read.bytesRead > 0, 'The owned proof file changed while reading.'); offset += read.bytesRead;
    }
    assert.equal((await file.read(Buffer.alloc(1), 0, 1, offset)).bytesRead, 0);
    for (const current of [await file.stat(), await fs.lstat(filePath)]) {
      assert(current.isFile() && !current.isSymbolicLink() && current.nlink === 1
        && current.uid === before.uid && (current.mode & 0o777) === mode && current.dev === before.dev
        && current.ino === before.ino && current.size === before.size
        && current.mtimeMs === before.mtimeMs && current.ctimeMs === before.ctimeMs,
      'The owned proof file changed while reading.');
    }
    return bytes;
  } finally { await file.close(); }
}

function assertNaturalWorkflowReadBody(message: NativeReadMessage, expected: Buffer, checksum: string): void {
  assert(message.role === 'toolResult' && message.toolName === 'read' && message.isError !== true);
  const details = message.details;
  assert(details && typeof details === 'object' && !Array.isArray(details));
  for (const field of ['filePath', 'requestedPath', 'resolvedPath', 'absPath', 'proposal', 'toolOutputRead']) {
    assert.equal(details[field], undefined, 'The native read proof must preserve private-path redaction.');
  }
  const body = expected.toString('utf8');
  assert(details.sha256 === checksum && details.type === 'text' && details.size === expected.length
    && details.textLength === body.length && details.totalChars === body.length && details.offset === 0
    && details.nextOffset === body.length && details.eof === true && details.truncated === false,
  'The native read must contain the complete immutable V2 skill.');
  const window = details.toolOutputReadWindow as { bodyStart?: unknown; bodyEnd?: unknown } | undefined;
  assert(window && Number.isSafeInteger(window.bodyStart) && Number.isSafeInteger(window.bodyEnd));
  assert(Array.isArray(message.content));
  const text = message.content.filter(block => block.type === 'text').map(block => {
    assert(typeof block.text === 'string'); return block.text;
  }).join('\n');
  const start = Number(window.bodyStart), end = Number(window.bodyEnd);
  assert(start >= 0 && end >= start && end <= text.length);
  const returned = Buffer.from(text.slice(start, end), 'utf8');
  assert(returned.equals(expected) && createHash('sha256').update(returned).digest('hex') === checksum,
    'The authenticated public native read body must match the immutable V2 bytes.');
}

/** A successful call does not echo its schema. Bind the actual submitted schema to current describe evidence separately. */
function assertNaturalWorkflowTranscriptBindings(messages: NativeReadMessage[], run: Run, organizationId: string): TranscriptBindingProof[] {
  assert(messages.filter(message => message.role === 'toolResult').every(message =>
    !message.isError && !message.details?.error && !message.details?.integrationError),
  'Every actual public tool result must be free of execution and integration errors.');
  const calls = messages.filter(message => message.role === 'assistant').flatMap(message =>
    Array.isArray(message.content) ? message.content.filter(block => block.type === 'toolCall') : []);
  const scripts = calls.filter(call => call.name === 'run_canvas_skill_script'); assert.equal(scripts.length, 1);
  const scriptCall = scripts[0];
  assert(typeof scriptCall.id === 'string' && naturalWorkflowHash(scriptCall.id) === run.scriptCallIdHash);
  assert(scriptCall.arguments && typeof scriptCall.arguments === 'object' && !Array.isArray(scriptCall.arguments));
  const argumentsRecord = scriptCall.arguments as Record<string, unknown>;
  assert.deepEqual(argumentsRecord.arguments, { label: run.label, query: run.query });
  const selected = argumentsRecord.selectedBindings as Array<{ alias: string; toolRef: string; schemaRef: string }>;
  assert(Array.isArray(selected) && selected.length === 2);
  assert.deepEqual(selected.map(binding => binding.alias).sort(), ['design_composio', 'design_mcp']);
  const scriptResults = messages.filter(message => message.role === 'toolResult'
    && message.toolName === 'run_canvas_skill_script' && message.toolCallId === scriptCall.id);
  assert.equal(scriptResults.length, 1); const scriptResult = scriptResults[0];
  assert(scriptResult.isError !== true && scriptResult.details?.kind === 'skill_script_result'
    && scriptResult.details.success === true && scriptResult.details.safeToAutoRetry === false
    && scriptResult.details.publishedRevisionRef === run.package.publishedRevisionRef
    && scriptResult.details.checksum === run.package.checksum
    && typeof scriptResult.details.scriptRef === 'string'
    && naturalWorkflowHash(scriptResult.details.scriptRef) === run.scriptRefHash);
  assert(argumentsRecord.scriptRef === scriptResult.details.scriptRef,
    'The actual submitted script reference must match its paired successful result.');
  const effects = scriptResult.details.toolResults as Array<{ toolName: string; result: { details?: Record<string, unknown> } }>;
  assert(Array.isArray(effects) && effects.length === 2);
  const integrationResults = messages.filter(message => message.role === 'toolResult' && message.toolName === 'integrations');
  const providers: IntegrationProviderDescriptor[] = integrationResults.flatMap(message =>
    Array.isArray(message.details?.providers) ? message.details.providers as IntegrationProviderDescriptor[] : []);
  const proof: TranscriptBindingProof[] = [];
  for (const source of ['mcp', 'composio'] as const) {
    const alias = `design_${source}`;
    const submitted = selected.filter(binding => binding.alias === alias); assert.equal(submitted.length, 1);
    const selectedBinding = submitted[0];
    assert.deepEqual(Object.keys(selectedBinding).sort(), ['alias', 'schemaRef', 'toolRef']);
    assert(typeof selectedBinding.toolRef === 'string' && typeof selectedBinding.schemaRef === 'string');
    const recorded = run.selectedBindings.filter(binding => binding.alias === alias); assert.equal(recorded.length, 1);
    assert(naturalWorkflowHash(selectedBinding.toolRef) === recorded[0].toolRefHash
      && naturalWorkflowHash(selectedBinding.schemaRef) === recorded[0].schemaRefHash);
    const recordedEffects = run.effects.filter(effect => effect.source === source); assert.equal(recordedEffects.length, 1);
    const recordedEffect = recordedEffects[0];
    const descriptions = integrationResults.filter(message => {
      const details = message.details, tag = details?.integrations as Record<string, unknown> | undefined;
      return tag?.action === 'describe' && details?.toolRef === selectedBinding.toolRef
        && details.schemaRef === selectedBinding.schemaRef;
    });
    assert(descriptions.length > 0, 'Each actual selected schema must have an authenticated current describe result.');
    const description = descriptions[0], providerRef = description.details?.providerRef;
    assert(typeof providerRef === 'string' && providerRef.length > 0 && providerRef.length <= 256);
    const inputSchema = description.details?.inputSchema;
    assert(typeof inputSchema === 'boolean' || inputSchema && typeof inputSchema === 'object' && !Array.isArray(inputSchema));
    const inputSchemaHash = naturalWorkflowHash(JSON.stringify(inputSchema));
    for (const current of descriptions) {
      assert(current.isError !== true && !current.details?.error && !current.details?.integrationError
        && current.details?.providerRef === providerRef
        && naturalWorkflowHash(JSON.stringify(current.details.inputSchema)) === inputSchemaHash);
      const describeCalls = calls.filter(call => {
        const args = call.arguments as Record<string, unknown> | undefined;
        return call.name === 'integrations' && call.id === current.toolCallId
          && args?.action === 'describe' && args.toolRef === selectedBinding.toolRef;
      });
      assert.equal(describeCalls.length, 1);
      assert(messages.indexOf(current) < messages.findIndex(message => message.role === 'assistant'
        && Array.isArray(message.content) && message.content.includes(scriptCall)),
      'The authenticated schema describe must precede its actual submitted script binding.');
    }
    const scopedProviders = providers.filter(provider => provider.providerRef === providerRef);
    assert(scopedProviders.length > 0);
    for (const provider of scopedProviders) {
      assert(provider.source === source && provider.scope.resourceId === recordedEffect.connectionRef);
      if (source === 'mcp') assert(provider.scope.type === 'workspace'
        && provider.scope.organizationId === organizationId && provider.scope.workspaceId === run.workspaceId);
      else assert(provider.scope.type === 'organization' && provider.scope.organizationId === organizationId);
    }
    const matchingEffects = effects.filter(effect => {
      const tag = effect.result.details?.integrations as Record<string, unknown> | undefined;
      return tag?.source === source;
    });
    assert.equal(matchingEffects.length, 1); const effect = matchingEffects[0];
    const tag = effect.result.details?.integrations as Record<string, unknown> | undefined;
    const receipt = effect.result.details?.integrationReceipt as Record<string, unknown> | undefined;
    assert(effect.toolName === 'integrations' && tag?.version === 1 && tag.action === 'call'
      && tag.toolRef === selectedBinding.toolRef && tag.providerRef === providerRef && tag.source === source
      && tag.schemaRef === undefined && receipt?.action === 'call' && receipt.source === source
      && receipt.toolName === recordedEffect.toolName);
    proof.push({ source, providerRef, toolRefHash: recorded[0].toolRefHash, schemaRefHash: recorded[0].schemaRefHash,
      inputSchemaHash, toolCallIdHash: recordedEffect.toolCallIdHash, connectionRef: recordedEffect.connectionRef });
  }
  return proof;
}

async function assertNaturalWorkflowSkillReadEvidence(input: {
  client: PoolClient; root: string; nonce: string; browser: BrowserProof; run: Run; index: number;
}): Promise<{ readProof: Record<string, unknown>; bindings: TranscriptBindingProof[] }> {
  const { client, root, nonce, browser, run, index } = input;
  const organizationId = `agent-settings-browser-${nonce}`;
  const publishedRows = (await client.query(`SELECT v.revision_ref,v.resource_ref,v.kind,v.name,v.version,v.checksum,
    CASE WHEN octet_length(v.files)<=2097152 THEN v.files ELSE NULL END AS files,v.base_revision_ref,
    r.storage_scope_type,r.storage_organization_id,r.storage_owner_user_id,r.ownership_type,r.organization_id,
    r.owner_user_id,r.team_workspace_id,r.artifact_name,r.status,s.current_published_revision_ref,
    w.organization_id AS workspace_organization_id,w.type AS workspace_type,w.status AS workspace_status
    FROM capability_package_versions v JOIN capability_resources r ON r.resource_ref=v.resource_ref
    JOIN capability_package_states s ON s.resource_ref=v.resource_ref
    JOIN canvas_workspaces w ON w.id=r.team_workspace_id
    WHERE v.resource_ref=$1 AND v.revision_ref=ANY($2::text[]) LIMIT 3`,
  [run.package.resourceRef, browser.publications.map(pin => pin.publishedRevisionRef)])).rows as Array<{
    revision_ref: string; resource_ref: string; kind: string; name: string; version: string; checksum: string;
    files: string | null; base_revision_ref: string | null; storage_scope_type: string;
    storage_organization_id: string; storage_owner_user_id: string | null; ownership_type: string;
    organization_id: string; owner_user_id: string | null; team_workspace_id: string;
    artifact_name: string; status: string; current_published_revision_ref: string;
    workspace_organization_id: string; workspace_type: string; workspace_status: string;
  }>;
  assert.equal(publishedRows.length, 2);
  const snapshots: Array<{ bytes: Buffer; checksum: string }> = [];
  for (const pin of browser.publications) {
    const matched = publishedRows.filter(row => row.revision_ref === pin.publishedRevisionRef);
    assert.equal(matched.length, 1); const row = matched[0];
    assert(row.resource_ref === pin.resourceRef && row.kind === 'plugin' && row.version === pin.version
      && row.checksum === pin.checksum && row.status === 'active'
      && row.storage_scope_type === 'organization' && row.storage_organization_id === organizationId
      && row.organization_id === organizationId && row.storage_owner_user_id === null
      && row.ownership_type === 'team' && row.team_workspace_id === run.workspaceId && row.owner_user_id === null
      && row.current_published_revision_ref === run.package.publishedRevisionRef && row.artifact_name === row.name
      && row.workspace_organization_id === organizationId && row.workspace_type === 'team' && row.workspace_status === 'active');
    assert(typeof row.name === 'string' && row.name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(row.name));
    const resource = /^canvas-resource:([a-f0-9-]{36})$/u.exec(row.resource_ref);
    const revision = /^canvas-package-revision:([a-f0-9-]{36})$/u.exec(row.revision_ref);
    assert(resource && revision && typeof row.files === 'string');
    const entries = JSON.parse(row.files) as Array<{ path: string; size: number; checksum: string }>;
    assert(Array.isArray(entries) && entries.length > 0 && entries.length <= 2_000);
    const skills = entries.filter(entry => entry.path === nativeSkillRelativePath); assert.equal(skills.length, 1);
    const skill = skills[0];
    assert(Number.isSafeInteger(skill.size) && skill.size > 0 && skill.size <= naturalProofByteLimit
      && /^[a-f0-9]{64}$/u.test(skill.checksum));
    const relative = path.join('data', 'organizations', organizationId, 'capability-packages', 'published',
      resource[1], revision[1], row.name, nativeSkillRelativePath);
    let directory = root;
    const directories = [root];
    for (const part of path.dirname(relative).split(path.sep)) { directory = path.join(directory, part); directories.push(directory); }
    const observed: Stats[] = [];
    for (const location of directories) {
      const stat = await fs.lstat(location);
      assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.()
        && (stat.mode & 0o077) === 0 && await fs.realpath(location) === location);
      observed.push(stat);
    }
    const bytes = await readNaturalWorkflowProofBytes(path.join(root, relative), 0o400);
    assert(bytes.length === skill.size && createHash('sha256').update(bytes).digest('hex') === skill.checksum);
    for (const [position, location] of directories.entries()) {
      const stat = await fs.lstat(location), before: Stats = observed[position];
      assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === before.uid && (stat.mode & 0o077) === 0
        && stat.dev === before.dev && stat.ino === before.ino && await fs.realpath(location) === location);
    }
    snapshots.push({ bytes, checksum: skill.checksum });
  }
  assert(publishedRows.find(row => row.revision_ref === run.package.publishedRevisionRef)?.base_revision_ref
    === browser.publications[0].publishedRevisionRef);
  const [v1, v2] = snapshots;
  assert(!v1.bytes.equals(v2.bytes) && v1.checksum !== v2.checksum,
    'The authored V2 skill body must differ from V1 independently of the script version.');
  const transcriptRelative = `natural-workflow-evidence/user-${index + 1}-transcript.json`;
  const evidenceDirectory = path.join(root, 'natural-workflow-evidence');
  const evidenceBefore = await fs.lstat(evidenceDirectory);
  assert(evidenceBefore.isDirectory() && !evidenceBefore.isSymbolicLink() && evidenceBefore.uid === process.getuid?.()
    && (evidenceBefore.mode & 0o777) === 0o700 && await fs.realpath(evidenceDirectory) === evidenceDirectory);
  const artifacts = browser.evidence.filter(artifact => artifact.relative === transcriptRelative);
  assert.equal(artifacts.length, 1); assert.equal(artifacts[0].sha256, run.transcriptSHA);
  const transcript = await readNaturalWorkflowProofBytes(path.join(root, transcriptRelative), 0o600);
  assert.equal(createHash('sha256').update(transcript).digest('hex'), run.transcriptSHA);
  const publicMessages = JSON.parse(transcript.toString('utf8')) as NativeReadMessage[];
  assert(Array.isArray(publicMessages) && publicMessages.length > 0 && publicMessages.length <= 200);
  const bindings = assertNaturalWorkflowTranscriptBindings(publicMessages, run, organizationId);
  const runtimeRelative = `natural-workflow-evidence/user-${index + 1}-session-model.json`;
  const runtimeArtifacts = browser.evidence.filter(artifact => artifact.relative === runtimeRelative);
  assert.equal(runtimeArtifacts.length, 1); assert.equal(runtimeArtifacts[0].sha256, run.runtimeHash);
  const runtimeBytes = await readNaturalWorkflowProofBytes(path.join(root, runtimeRelative), 0o600);
  assert.equal(createHash('sha256').update(runtimeBytes).digest('hex'), run.runtimeHash);
  const runtime = JSON.parse(runtimeBytes.toString('utf8')) as NaturalWorkflowSessionModel;
  assert(runtime && typeof runtime === 'object' && !Array.isArray(runtime)
    && runtime.userId === run.actorId && runtime.sessionId === run.sessionId && runtime.agentId === run.agentId
    && runtime.workspaceId === run.workspaceId && runtime.organizationId === organizationId
    && runtime.providerInstallationId === browser.model.installationId
    && /^aip_[a-f0-9]{24}$/u.test(runtime.providerInstallationId)
    && runtime.providerId === 'ollama' && runtime.modelId === 'kimi-k2.6:cloud' && runtime.thinkingLevel === 'off'
    && runtime.credentialScope === 'organization' && runtime.status === 'ready'
    && (runtime.selectionSource === 'app_default' || runtime.selectionSource === 'session')
    && Number.isSafeInteger(runtime.catalogRevision) && runtime.catalogRevision >= 0
    && Number.isSafeInteger(runtime.policyRevision) && runtime.policyRevision >= 0,
  'The hashed authenticated session/model readback must match the exact workflow actor and session.');
  assert(Array.isArray(run.skillReads) && run.skillReads.length > 0 && run.skillReads.length <= 200);
  assert.equal(new Set(run.skillReads.map(read => read.toolCallIdHash)).size, run.skillReads.length);
  {
    const messages = publicMessages;
    const calls = messages.filter(message => message.role === 'assistant').flatMap(message =>
      Array.isArray(message.content) ? message.content.filter(block => block.type === 'toolCall') : []);
    const skillCalls = calls.filter(call => call.name === 'read');
    assert.equal(skillCalls.length, run.skillReads.length);
    const scriptCalls = calls.filter(call => call.name === 'run_canvas_skill_script'); assert.equal(scriptCalls.length, 1);
    assert(typeof scriptCalls[0].id === 'string' && naturalWorkflowHash(scriptCalls[0].id) === run.scriptCallIdHash);
    const readResults = messages.filter(message => message.role === 'toolResult' && message.toolName === 'read');
    assert.equal(readResults.length, skillCalls.length);
    for (const read of run.skillReads) {
      assert(/^[a-f0-9]{64}$/u.test(read.toolCallIdHash) && read.relativePath === nativeSkillRelativePath
        && read.bodySHA === v2.checksum && read.byteLength === v2.bytes.length);
      const matchingCalls = skillCalls.filter(call => typeof call.id === 'string' && naturalWorkflowHash(call.id) === read.toolCallIdHash);
      assert.equal(matchingCalls.length, 1); const call = matchingCalls[0]; assert.deepEqual(call.arguments, {});
      const matchingResults = readResults.filter(message => message.toolCallId === call.id); assert.equal(matchingResults.length, 1);
      assertNaturalWorkflowReadBody(matchingResults[0], v2.bytes, v2.checksum);
      assert(messages.indexOf(matchingResults[0]) < messages.findIndex(message =>
        message.role === 'assistant' && Array.isArray(message.content) && message.content.includes(scriptCalls[0])),
      'The complete skill read must precede the actual script call.');
    }
  }
  const evidenceAfter = await fs.lstat(evidenceDirectory);
  assert(evidenceAfter.isDirectory() && !evidenceAfter.isSymbolicLink() && evidenceAfter.uid === evidenceBefore.uid
    && (evidenceAfter.mode & 0o777) === 0o700 && evidenceAfter.dev === evidenceBefore.dev
    && evidenceAfter.ino === evidenceBefore.ino && await fs.realpath(evidenceDirectory) === evidenceDirectory);
  return { bindings, readProof: { actorHash: run.actorHash, sessionHash: run.sessionHash, transcriptSHA: run.transcriptSHA,
    resourceRef: run.package.resourceRef, publishedRevisionRef: run.package.publishedRevisionRef,
    packageChecksum: run.package.checksum, relativePath: nativeSkillRelativePath, bodySHA: v2.checksum,
    v1BodySHA: v1.checksum, byteLength: v2.bytes.length, publicMessageRows: publicMessages.length,
    toolCallIdHashes: run.skillReads.map(read => read.toolCallIdHash), completeV2BodyVerified: true,
    sessionIdentityEvidence: 'authenticated-browser-session-model-readback', sessionRuntimeHash: run.runtimeHash,
    messageEvidence: 'hashed-authenticated-public-transcript', persistedMessagesReadAfterChatDeletion: false,
    literalResolvedPathObserved: false } };
}

/** Read only the owned nonce database after ordinary auth/chat closure and before normal DROP. */
export async function assertNaturalWorkflowParentProof(input: {
  database: Pool; databaseName: string; root: string; nonce: string; actorId: string;
  provider: IntegrationBrowserProviderCalls;
}): Promise<void> {
  const receiptPath = path.join(input.root, 'browser-receipt.json');
  const handle = await fs.open(receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let browser: BrowserProof;
  try {
    const before = await handle.stat();
    assert(before.isFile() && before.nlink === 1 && before.uid === process.getuid?.()
      && (before.mode & 0o777) === 0o600 && before.size > 0 && before.size < 256 * 1024);
    browser = JSON.parse(await handle.readFile('utf8')) as BrowserProof;
    const current = await fs.lstat(receiptPath);
    assert(current.isFile() && !current.isSymbolicLink() && current.dev === before.dev && current.ino === before.ino
      && current.size === before.size && current.mtimeMs === before.mtimeMs && current.ctimeMs === before.ctimeMs);
  } finally { await handle.close(); }
  assert.equal(browser.version, 1); assert.equal(browser.nonce, input.nonce); assert.equal(browser.actorId, input.actorId);
  assert.equal(browser.phase, 'verified_closed'); assert.equal(browser.outstanding, null); assert.equal(browser.failure, undefined);
  assert.equal(browser.closedContexts, true); assert.equal(browser.authClosed, true);
  assert.equal(browser.domainCleanup, 'owned-parent-after-verified-auth-closure');
  assert.equal(browser.actorIds.length, 3); assert.equal(new Set(browser.actorIds).size, 3);
  assert.deepEqual([...browser.normalSessionNull].sort(), [...browser.actorIds].sort());
  assert.equal(browser.agentIds.length, 1); assert.equal(browser.workspaceIds.length, 1);
  assert.equal(browser.connectionRefs.length, 2); assert.equal(new Set(browser.connectionRefs).size, 2);
  assert.equal(browser.publications.length, 2); assert.equal(browser.publications[0].version, '1.0.0');
  assert.equal(browser.publications[1].version, '2.0.0');
  assert.equal(browser.publications[0].resourceRef, browser.publications[1].resourceRef);
  assert.notEqual(browser.publications[0].publishedRevisionRef, browser.publications[1].publishedRevisionRef);
  assert.notEqual(browser.publications[0].checksum, browser.publications[1].checksum);
  assert.equal(browser.model.providerId, 'ollama'); assert.equal(browser.model.modelId, 'kimi-k2.6:cloud');
  assert.equal(browser.model.credentialScope, 'organization'); assert.equal(browser.model.status, 'ready');
  assert.equal(browser.model.verificationCode, 'PROVIDER_VERIFIED');
  assert.equal(browser.runs.length, 2);
  for (const field of ['actorId', 'authSessionHash', 'sessionId', 'scratchHash', 'label', 'query'] as const) {
    assert.equal(new Set(browser.runs.map(run => run[field])).size, 2);
  }
  assert.deepEqual(browser.provider.executions, input.provider.executions);
  assert.equal(input.provider.executions.length, 4);
  assert.equal(input.provider.executions.filter(item => item.source === 'mcp').length, 2);
  assert.equal(input.provider.executions.filter(item => item.source === 'composio').length, 2);
  assert(input.provider.executions.every(item => item.exactBinding === true && item.successful === true));
  assert(/^[A-Za-z0-9_-]{43}$/u.test(browser.sharedAccountHash));
  assert(/^[A-Za-z0-9_-]{43}$/u.test(browser.sharedProfileEntityHash));
  for (const execution of input.provider.executions.filter(item => item.source === 'composio')) {
    assert.equal(execution.accountHash, browser.sharedAccountHash);
    assert.equal(execution.userHash, browser.sharedProfileEntityHash);
    assert.equal(execution.versionHash, createHash('sha256').update('20261006_03').digest('base64url'));
  }
  const client = await input.database.connect();
  let transaction = false;
  const auditProof: Array<Record<string, string>> = [];
  const nativeSkillProof: Array<Record<string, unknown>> = [];
  try {
    await client.query('BEGIN READ ONLY'); transaction = true;
    await client.query("SET LOCAL statement_timeout = '5s'");
    assert.equal((await client.query('SELECT current_database() AS name')).rows[0]?.name, input.databaseName);
    const audits = (await client.query(`SELECT user_id,session_id,agent_id,workspace_id,status,metadata_json
      FROM audit_events WHERE source='agent_tool' AND entity_type='integration_tool'
      AND action='integrations.call' ORDER BY created_at,id LIMIT 5`)).rows as Array<{
        user_id: string; session_id: string; agent_id: string; workspace_id: string; status: string; metadata_json: string;
      }>;
    assert.equal(audits.length, 4, 'Exactly four actual nested integration audit calls must exist.');
    for (const [index, run] of browser.runs.entries()) {
      assert(browser.actorIds.includes(run.actorId)); assert.notEqual(run.actorId, input.actorId);
      assert.equal(run.actorHash, naturalWorkflowHash(run.actorId)); assert.equal(run.sessionHash, naturalWorkflowHash(run.sessionId));
      assert.equal(run.agentId, browser.agentIds[0]); assert.equal(run.workspaceId, browser.workspaceIds[0]);
      assert.deepEqual(run.package, browser.publications[1]);
      assert.deepEqual(run.providerExecutions, input.provider.executions.slice(index * 2, index * 2 + 2));
      assert.deepEqual(run.providerExecutions.map(item => item.source), ['mcp', 'composio']);
      assert.equal(run.providerExecutions[0].name, 'canva_find_designs');
      assert.equal(run.providerExecutions[1].name, 'CANVA_LIST_DESIGNS');
      assert.equal(run.providerExecutions[0].argumentsHash, createHash('sha256')
        .update(JSON.stringify({ design_query: run.query, exact_match: false })).digest('base64url'));
      assert.equal(run.providerExecutions[1].argumentsHash, createHash('sha256')
        .update(JSON.stringify({ query: run.query })).digest('base64url'));
      assert.equal(run.effects.length, 2); assert.equal(run.selectedBindings.length, 2);
      const transcriptEvidence = await assertNaturalWorkflowSkillReadEvidence({ client, root: input.root, nonce: input.nonce, browser, run, index });
      nativeSkillProof.push(transcriptEvidence.readProof);
      const ownAudits = audits.filter(audit => audit.user_id === run.actorId && audit.session_id === run.sessionId);
      assert.equal(ownAudits.length, 2);
      for (const source of ['mcp', 'composio']) {
        const effect = run.effects.find(item => item.source === source);
        const binding = run.selectedBindings.find(item => item.alias === `design_${source}`);
        assert(effect && binding && browser.connectionRefs.includes(effect.connectionRef));
        const transcriptBindings = transcriptEvidence.bindings.filter(item => item.source === source);
        assert.equal(transcriptBindings.length, 1); const transcriptBinding = transcriptBindings[0];
        assert(transcriptBinding.toolRefHash === binding.toolRefHash && transcriptBinding.schemaRefHash === binding.schemaRefHash
          && transcriptBinding.toolCallIdHash === effect.toolCallIdHash && transcriptBinding.connectionRef === effect.connectionRef);
        assert.equal(effect.toolName, source === 'mcp' ? 'canva_find_designs' : 'CANVA_LIST_DESIGNS');
        const matched = ownAudits.filter(audit => {
          assert.equal(audit.agent_id, run.agentId); assert.equal(audit.workspace_id, run.workspaceId);
          assert.equal(audit.status, 'success'); assert(audit.metadata_json.length <= 4096);
          const metadata = JSON.parse(audit.metadata_json) as { version?: number; action?: string; source?: string;
            toolCallId?: string; toolRef?: string; providerRef?: string };
          return metadata.version === 1 && metadata.action === 'call' && metadata.source === source
            && typeof metadata.toolCallId === 'string' && typeof metadata.toolRef === 'string'
            && metadata.providerRef === transcriptBinding.providerRef
            && naturalWorkflowHash(metadata.toolCallId) === effect.toolCallIdHash
            && naturalWorkflowHash(metadata.toolRef) === binding.toolRefHash;
        });
        assert.equal(matched.length, 1, 'Actual audit actor/session/provider/tool call must match the authenticated transcript.');
        auditProof.push({ actorHash: run.actorHash, sessionHash: run.sessionHash, source,
          toolCallIdHash: effect.toolCallIdHash, toolRefHash: binding.toolRefHash, schemaRefHash: binding.schemaRefHash,
          inputSchemaHash: transcriptBinding.inputSchemaHash, providerRefHash: naturalWorkflowHash(transcriptBinding.providerRef),
          schemaRefEvidence: 'authenticated-submitted-selectedBindings-and-current-describe',
          connectionRef: effect.connectionRef });
      }
    }
    await client.query('COMMIT'); transaction = false;
  } finally {
    try { if (transaction) await client.query('ROLLBACK'); } finally { client.release(); }
  }
  const evidenceRoot = path.join(input.root, 'natural-workflow-evidence');
  const evidenceStat = await fs.lstat(evidenceRoot);
  assert(evidenceStat.isDirectory() && !evidenceStat.isSymbolicLink() && evidenceStat.uid === process.getuid?.()
    && (evidenceStat.mode & 0o777) === 0o700 && await fs.realpath(evidenceRoot) === evidenceRoot);
  assert.equal(new Set(browser.evidence.map(item => item.relative)).size, browser.evidence.length);
  for (const [index, run] of browser.runs.entries()) {
    const transcript = browser.evidence.filter(item => item.relative === `natural-workflow-evidence/user-${index + 1}-transcript.json`);
    assert.equal(transcript.length, 1); assert.equal(transcript[0].sha256, run.transcriptSHA);
  }
  for (const artifact of browser.evidence) {
    assert(/^natural-workflow-evidence\/[a-z0-9][a-z0-9.-]+$/u.test(artifact.relative));
    assert(/^[a-f0-9]{64}$/u.test(artifact.sha256));
    const file = await fs.open(path.join(input.root, artifact.relative), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      assert(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600
        && stat.size > 0 && stat.size < 10 * 1024 * 1024);
      assert.equal(createHash('sha256').update(await file.readFile()).digest('hex'), artifact.sha256);
    } finally { await file.close(); }
  }
  const evidenceAfter = await fs.lstat(evidenceRoot);
  assert(evidenceAfter.isDirectory() && !evidenceAfter.isSymbolicLink() && evidenceAfter.uid === evidenceStat.uid
    && (evidenceAfter.mode & 0o777) === 0o700 && evidenceAfter.dev === evidenceStat.dev && evidenceAfter.ino === evidenceStat.ino
    && await fs.realpath(evidenceRoot) === evidenceRoot);
  for (const source of ['mcp', 'composio']) {
    assert.equal(new Set(browser.runs.map(run => run.effects.find(effect => effect.source === source)?.connectionRef)).size, 1);
    assert.equal(new Set(browser.runs.map(run => run.selectedBindings.find(binding => binding.alias === `design_${source}`)?.schemaRefHash)).size, 2);
  }
  const sourcePaths = ['tests/agent-workflow-natural-model-local.spec.ts', 'tests/helpers/natural-workflow-model-setup.ts',
    'app/lib/skills/script-runtime/sdk/node.cjs', 'app/lib/skills/script-runtime/tool-bridge.ts',
    'app/lib/pi/skill-script-tools.ts', 'app/lib/pi/integration-tool-gateway.ts'];
  assert.deepEqual(Object.keys(browser.sourceHashes).sort(), [...sourcePaths].sort());
  for (const relative of sourcePaths) {
    assert.equal(createHash('sha256').update(await fs.readFile(path.join(process.cwd(), relative))).digest('hex'), browser.sourceHashes[relative]);
  }
  await fs.writeFile(path.join(input.root, 'natural-audit-proof.json'), JSON.stringify({ version: 1, nonce: input.nonce,
    readOnly: true, transactionCommitted: true, clientReleased: true, auditCalls: 4, actors: 2, rows: auditProof,
    nativeSkillReads: nativeSkillProof, schemaRefObservedInCallAudit: false,
    schemaBindingEvidence: 'authenticated-selectedBindings-current-describe-and-dispatcher-validated-successful-effect' }),
  { mode: 0o600, flag: 'wx' });
}
