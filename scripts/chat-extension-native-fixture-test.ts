import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertNativeRetypedSkillCaption, createNativeExtensionWorkflow, nativeExtensionSkillCaption, nativeExtensionStandaloneSkillContent, nativePreparationFailureDiagnostic } from './helpers/chat-extension-native-fixture';
import type { AgentExtensionPackageVersion } from '../app/lib/agents/extension-options-contracts';
import { isWorkflowManifestError, parseWorkflowManifest, validateWorkflowReferences } from '../app/lib/capabilities/workflow-contracts';
import { validateCanvasPluginPackage } from '../app/lib/plugins/canvas-plugin-manifest';
import { loadCanvasSkillWorkflow, parseSkillFile } from '../app/lib/skills/canvas-skill-manifest';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-native-extension-parser-'));
  const connector = 'native-mcp-0123456789', name = 'native-child-0123456789', skillRoot = path.join(root, 'skills', name);
  const workflow = createNativeExtensionWorkflow(connector);
  try {
    const diagnostic = nativePreparationFailureDiagnostic({ phase: 'Publish actual source', pathname: '/api/capabilities/packages/drafts/owned/publish', status: 400, expectedStatus: 200,
      bytes: Buffer.from(JSON.stringify({ code: 'PACKAGE_INVALID', error: 'PRIVATE_RESPONSE_VALUE', token: 'PRIVATE_TOKEN', nested: { accountId: 'PRIVATE_ACCOUNT' } })) });
    assert.equal(diagnostic.code, 'PACKAGE_INVALID'); assert.equal(diagnostic.status, 400); assert.equal(diagnostic.expectedStatus, 200);
    assert.match(diagnostic.bodySha256, /^[a-f0-9]{64}$/u); assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_/u);
    assert(JSON.stringify(diagnostic).length < 1_024);
    assert.equal(nativePreparationFailureDiagnostic({ phase: 'bounded', pathname: '/', status: 500, expectedStatus: 200,
      bytes: Buffer.from(JSON.stringify({ code: 'PRIVATE_RESPONSE_VALUE'.repeat(20), token: 'PRIVATE_TOKEN' })) }).code, null);
    assert.equal(nativePreparationFailureDiagnostic({ phase: 'bounded', pathname: '/', status: 500, expectedStatus: 200,
      bytes: Buffer.from('x'.repeat(65_537)) }).code, null);
    await fs.mkdir(path.join(root, '.canvas-plugin'), { mode: 0o700 });
    await fs.mkdir(path.join(skillRoot, 'agents'), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(root, '.canvas-plugin/plugin.json'), JSON.stringify({ name: 'native-plugin-0123456789', version: '1.0.0',
      description: 'Owned native exact extension package', skills: './skills',
      connectors: { mcp: [{ name: connector, required: true, oauth: true, configPath: 'mcp.json' }] } }), { mode: 0o600 });
    await fs.writeFile(path.join(root, 'mcp.json'), JSON.stringify({ mcpServers: { [connector]: { url: 'https://owned-fixture.invalid/mcp', transport: 'http', auth: 'oauth' } } }), { mode: 0o600 });
    await fs.writeFile(path.join(skillRoot, 'SKILL.md'), `---\nname: ${name}\ndescription: Native exact selected package\n---\nUse the currently selected connection only.\n`, { mode: 0o600 });
    const declarationPath = path.join(skillRoot, 'agents/canvas.yaml');
    await fs.writeFile(declarationPath, `workflow: ${JSON.stringify(workflow)}\n`, { mode: 0o600 });

    const plugin = await validateCanvasPluginPackage(root);
    assert.equal(plugin.valid, true, plugin.errors.join(' ')); assert(plugin.manifest);
    assert.deepEqual(await loadCanvasSkillWorkflow(skillRoot), workflow);
    const child = await parseSkillFile(path.join(skillRoot, 'SKILL.md')); assert(child?.workflow);
    assert.deepEqual(child.workflow, workflow, 'The real import child parser must retain the exact shared fixture declaration.');
    const standaloneName = 'native-skill-0123456789', standaloneRoot = path.join(root, standaloneName);
    await fs.mkdir(standaloneRoot, { mode: 0o700 });
    await fs.writeFile(path.join(standaloneRoot, 'SKILL.md'), nativeExtensionStandaloneSkillContent(standaloneName), { mode: 0o600 });
    const standalone = await parseSkillFile(path.join(standaloneRoot, 'SKILL.md')); assert(standalone);
    assert.equal(standalone.name, standaloneName); assert.equal(standalone.title, 'Native Skill 0123456789');
    const pin = { resourceRef: 'actual-skill-ref', publishedRevisionRef: 'actual-published-ref', checksum: 'a'.repeat(64) };
    const metadata: AgentExtensionPackageVersion = { pin, kind: 'skill', name: standalone.name, displayName: standalone.title,
      description: standalone.description, version: '1.0.0', children: [{ name: standalone.name, title: standalone.title,
        description: standalone.description, relativeRoot: '', origin: 'standalone', required: false }], declarations: [] };
    const selection = { kind: 'skill' as const, origin: 'standalone' as const, relativeRoot: '', package: pin };
    const caption = nativeExtensionSkillCaption(metadata, selection); assert.equal(caption, standalone.title); assert.notEqual(caption, standaloneName);
    assert.equal(nativeExtensionSkillCaption({ ...metadata, children: [{ ...metadata.children[0], title: undefined }] }, selection), standaloneName);
    assert.equal(nativeExtensionSkillCaption({ ...metadata, children: [{ ...metadata.children[0], title: '', name: '' }] }, selection), metadata.displayName);
    assert.throws(() => nativeExtensionSkillCaption(metadata, { ...selection, relativeRoot: 'missing' }));
    assert.throws(() => nativeExtensionSkillCaption(metadata, { ...selection, package: { ...pin, checksum: 'b'.repeat(64) } }));
    assert.throws(() => nativeExtensionSkillCaption({ ...metadata, children: [...metadata.children, ...metadata.children] }, selection));
    assertNativeRetypedSkillCaption(`PLAIN-marker ${caption}`, 'marker', caption);
    assert.throws(() => assertNativeRetypedSkillCaption(`PLAIN-marker ${standaloneName}`, 'marker', caption), 'The search slug cannot stand in for retyping the actual visible caption.');
    assert.throws(() => assertNativeRetypedSkillCaption(`PLAIN-marker ${caption} extra`, 'marker', caption));
    validateWorkflowReferences(child.workflow, { mcpConnectors: plugin.manifest.connectors?.mcp ?? [], skillNames: [child.name], allowMcpConnectors: false });
    assert.deepEqual(workflow.integrationCapabilities, [{ id: 'native-connection', application: 'native_mcp', required: true,
      alternatives: [{ source: 'mcp', connector, requiredTools: ['echo'] }, { source: 'composio', toolkit: 'canva', requiredTools: ['DESIGN_CREATE'] }] }]);
    assert.throws(() => validateWorkflowReferences(child.workflow!, { mcpConnectors: [], skillNames: [child.name], allowMcpConnectors: false }), isWorkflowManifestError);

    const oldInvalid = { ...workflow, integrationCapabilities: [{ ...workflow.integrationCapabilities[0], application: 'Native MCP' }] };
    const invalidApplication = (error: unknown) => isWorkflowManifestError(error) && error.errors.some(message => message.startsWith('workflow.integrationCapabilities.0.application:'));
    assert.throws(() => parseWorkflowManifest(oldInvalid), invalidApplication, 'The invalid display label must remain rejected by the canonical contract.');
    await fs.writeFile(declarationPath, `workflow: ${JSON.stringify(oldInvalid)}\n`, { mode: 0o600 });
    await assert.rejects(loadCanvasSkillWorkflow(skillRoot), invalidApplication, 'The exact previous setup failure must remain reproducible through the real YAML loader.');
    console.log('Native extension fixture: real manifest/child/YAML parser, actual standalone slug versus visible caption, exact retyped-caption proof, exact alternatives, invalid application and bounded secret-free diagnostics PASS.');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
