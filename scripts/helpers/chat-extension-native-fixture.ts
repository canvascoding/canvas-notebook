import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { parseWorkflowManifest, type GenericWorkflowManifestV1 } from '../../app/lib/capabilities/workflow-contracts';
import type { AgentExtensionPackageVersion } from '../../app/lib/agents/extension-options-contracts';
import type { ExtensionSelection } from '../../app/lib/capabilities/extensions/contracts';

/** Match the real picker caption, keeping the exact source identity separate from its label. */
export function nativeExtensionSkillCaption(metadata: AgentExtensionPackageVersion, selection: Extract<ExtensionSelection, { kind: 'skill' }>): string {
  assert.deepEqual(metadata.pin, selection.package);
  const children = metadata.children.filter(child => child.relativeRoot === selection.relativeRoot);
  assert.equal(children.length, 1, 'The exact selected skill must have one child in the actual package version.');
  assert.equal(children[0].origin, selection.origin);
  const caption = children[0].title || children[0].name || metadata.displayName;
  assert(typeof caption === 'string' && caption.trim().length > 0);
  return caption;
}

/** A retyped visible caption must match exactly while all separate authority checks remain in the parent. */
export function assertNativeRetypedSkillCaption(text: string, marker: string, caption: string): void {
  assert.equal(text, `PLAIN-${marker} ${caption}`);
}

/** One canonical declaration shared by Native preparation and its parser regression. */
export function createNativeExtensionWorkflow(connector: string): GenericWorkflowManifestV1 {
  return parseWorkflowManifest({ version: 1, integrationCapabilities: [{ id: 'native-connection', application: 'native_mcp', required: true,
    alternatives: [{ source: 'mcp', connector, requiredTools: ['echo'] },
      { source: 'composio', toolkit: 'canva', requiredTools: ['DESIGN_CREATE'] }] }] });
}

export function nativeExtensionStandaloneSkillContent(name: string): string {
  return `---\nname: ${name}\ndescription: INLINE_CONTEXT_SENTINEL native selected skill\nmetadata:\n  version: "1.0.0"\n---\nRead the exact selected source.\n`;
}

/** Actual import bytes are shared by both API preparation and its regression. */
export function nativeExtensionPluginFiles(input: { name: string; childRoot: string; connector: string; mcpConfiguration: { url: string; transport: string; auth: string } }): Record<string, string> {
  const childName = input.childRoot.split('/').at(-1)!;
  return {
    '.canvas-plugin/plugin.json': JSON.stringify({ name: input.name, version: '1.0.0', description: 'Owned native exact extension package', skills: './skills',
      interface: { logo: './logo.svg' }, connectors: { mcp: [{ name: input.connector, required: true, oauth: true, configPath: 'mcp.json' }] } }),
    'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#2471a3"/></svg>',
    'mcp.json': JSON.stringify({ mcpServers: { [input.connector]: input.mcpConfiguration } }),
    [`${input.childRoot}/SKILL.md`]: `---\nname: ${childName}\ndescription: Native exact selected package\n---\nUse the currently selected connection only.\n`,
    [`${input.childRoot}/agents/canvas.yaml`]: `workflow: ${JSON.stringify(createNativeExtensionWorkflow(input.connector))}\n`,
  };
}

/** Store only bounded status/contract metadata and a digest, never response values. */
export function nativePreparationFailureDiagnostic(input: { phase: string; pathname: string; status: number; expectedStatus: number; bytes: Buffer }) {
  let code: string | null = null;
  if (input.bytes.length <= 65_536) {
    try {
      const value: unknown = JSON.parse(input.bytes.toString('utf8'));
      if (value && typeof value === 'object' && Object.hasOwn(value, 'code')) {
        const candidate = Reflect.get(value, 'code');
        if (typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(candidate)) code = candidate;
      }
    } catch { /* Non-JSON failure bodies remain digest-only. */ }
  }
  return { version: 1, phase: input.phase.slice(0, 128), pathname: input.pathname.slice(0, 256), status: input.status,
    expectedStatus: input.expectedStatus, code, bodyBytes: input.bytes.length, bodySha256: createHash('sha256').update(input.bytes).digest('hex') };
}
