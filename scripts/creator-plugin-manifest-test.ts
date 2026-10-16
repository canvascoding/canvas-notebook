import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { creatorPluginManifestJsonSchema, creatorPluginManifestSchema, creatorPluginManifestTemplate,
  CREATOR_PLUGIN_MANIFEST_MAX_BYTES, validateCreatorPluginManifest } from '../app/lib/plugins/creator-plugin-manifest';
import { validateCanvasPluginPackage, isValidCanvasPluginVersion } from '../app/lib/plugins/canvas-plugin-manifest';
import { parseSkillFile } from '../app/lib/skills/canvas-skill-manifest';
import { parseWorkflowManifest, workflowManifestV1Schema, workflowMcpConnectorDescriptorSchema } from '../app/lib/capabilities/workflow-contracts';

type ObjectValue = Record<string, unknown>;
const base: ObjectValue = { ...structuredClone(creatorPluginManifestTemplate), name: 'research-toolkit',
  author: { name: 'Canvas fixture', url: 'https://author.example.test/' }, license: 'MIT',
  connectors: {
    mcp: [{ name: 'research', configPath: './connectors/research.json', env: ['RESEARCH_TOKEN'], required: false }],
    composio: [{ toolkit: 'hubspot', tools: ['HUBSPOT_READ_COMPANY'], required: false }],
    email: [{ kind: 'mailbox', providers: ['gmail', 'imap-smtp'], required: false }],
  },
  workflow: { version: 1, integrationCapabilities: [{ id: 'research', application: 'research', alternatives: [
    { source: 'mcp', connector: 'research', requiredTools: ['read_company'] }, { source: 'composio', toolkit: 'hubspot' },
  ], skillRefs: ['research'] }] },
};
const omit = Symbol('omit');
function changed(field: string, value: unknown): ObjectValue {
  const result = structuredClone(base);
  const keys = field.split('.');
  const owner = keys.slice(0, -1).reduce((entry, key) => entry[key] as ObjectValue, result);
  if (value === omit) delete owner[keys.at(-1)!]; else owner[keys.at(-1)!] = value;
  return result;
}

async function main() {
  const jsonSchemaFile = path.join(process.cwd(), 'app/lib/plugins/schemas/creator-plugin-manifest.v1.schema.json');
  assert.deepEqual(JSON.parse(await fs.readFile(jsonSchemaFile, 'utf8')), creatorPluginManifestJsonSchema,
    'The checked-in machine-readable schema must be generated from the runtime contract.');
  const ajv = new Ajv({ allErrors: true, strict: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
  addFormats(ajv);
  const structural = ajv.compile(creatorPluginManifestJsonSchema);
  const valid = [structuredClone(creatorPluginManifestTemplate), base, changed('workflow', omit),
    changed('skills', '.'), changed('version', '12.3.4-rc.1'), changed('version', '12.3.4+build.1')];
  for (const value of valid) {
    const before = structuredClone(value);
    assert(structural(value), JSON.stringify(structural.errors));
    assert(creatorPluginManifestSchema.safeParse(value).success);
    assert(validateCreatorPluginManifest(JSON.stringify(value)).valid);
    assert.deepEqual(value, before, 'Neither schema transport coerces or modifies author input.');
    assert(isValidCanvasPluginVersion(String(value.version)), 'The canonical version is also supported by the existing runtime.');
  }

  const invalid: Array<[string, unknown]> = [
    ...['schemaVersion', 'name', 'version', 'description', 'skills', 'interface', 'interface.displayName', 'interface.shortDescription', 'interface.logo']
      .map(field => [field, changed(field, omit)] as [string, unknown]),
    ['unknown schema version', changed('schemaVersion', 2)], ['string schema version', changed('schemaVersion', '1')],
    ['numeric metadata version', changed('version', 1)], ['incomplete metadata version', changed('version', '1.2')],
    ['normalized name', changed('name', ' research-toolkit')], ['invalid name', changed('name', 'Research')],
    ['name hyphens', changed('name', 'research--toolkit')], ['description type', changed('description', [])],
    ['interface type', changed('interface', [])], ['brandColor', changed('interface.brandColor', 'green')],
    ['legacy interface alias', changed('interface.display_name', 'Legacy alias')],
    ['prompt coercion', changed('interface.defaultPrompt', 'One prompt')],
    ['connector coercion', changed('connectors.mcp', { name: 'research' })],
    ['legacy config alias', changed('connectors.mcpServers', './connectors/research.json')],
    ['legacy toolkit alias', changed('connectors.composioToolkits', ['hubspot'])],
    ['private identity', changed('connectors.mcp.0.providerRef', 'private-identity-fixture')],
    ['secret value in env', changed('connectors.mcp.0.env', ['RESEARCH_TOKEN=private-value-fixture'])],
    ['unknown provider', changed('connectors.email.0.providers', ['unsupported'])],
    ['workflow version', changed('workflow.version', 2)],
    ['workflow coercion', changed('workflow.integrationCapabilities.0.required', 'true')],
    ['workflow private identity', changed('workflow.integrationCapabilities.0.alternatives.0.accountId', 'private-identity-fixture')],
    ['external seed refs', changed('skillRefs', [{ name: 'create-plugin', source: 'seed' }])],
    ['unknown top field', changed('privateField', 'private-value-fixture')],
  ];
  for (const value of ['/absolute/logo.svg', '../logo.svg', './assets/../logo.svg', 'assets\\logo.svg',
    'https://images.example.test/logo.svg', './assets//logo.svg', './assets/logo.png', './assets/logo.svg ', './assets/./logo.svg']) {
    invalid.push([`logo ${value}`, changed('interface.logo', value)]);
  }
  for (const value of ['/absolute', '../skills', './skills/../outside', 'skills\\nested', 'https://files.example.test/skills', './skills//nested']) {
    invalid.push([`skills ${value}`, changed('skills', value)]);
  }
  for (const [label, value] of invalid) {
    assert.equal(structural(value), false, `JSON Schema accepted ${label}.`);
    assert.equal(creatorPluginManifestSchema.safeParse(value).success, false, `Runtime schema accepted ${label}.`);
    const result = validateCreatorPluginManifest(JSON.stringify(value));
    assert.equal(result.valid, false, label);
    assert(result.issues.length && result.issues.every(issue => issue.code && issue.message && issue.repair));
    assert(!JSON.stringify(result).includes('private-value-fixture'), 'Validation errors never echo secret-like input values.');
  }

  // These semantic rules use the existing workflow parser, rather than an independently implemented schema parser.
  const semantic = [changed('connectors.mcp', [{ name: 'research' }, { name: 'research' }]),
    changed('connectors.composio', [{ toolkit: 'hubspot' }, { toolkit: 'hubspot' }]),
    changed('workflow.integrationCapabilities.0.alternatives.0.connector', 'missing'),
    changed('workflow.integrationCapabilities.0.skillRefs', ['research', 'research']),
    changed('workflow.integrationCapabilities.0.alternatives', [{ source: 'mcp', connector: 'research' }, { source: 'mcp', connector: 'research' }])];
  for (const value of semantic) assert.equal(validateCreatorPluginManifest(JSON.stringify(value)).valid, false);
  assert.match(creatorPluginManifestJsonSchema.$comment, /references/);
  assert.throws(() => parseWorkflowManifest((semantic[3] as ObjectValue).workflow));

  const raw = JSON.stringify(base);
  for (const value of ['{invalid', `${raw.slice(0, -1)},"name":"duplicate"}`,
    raw.replace('"schemaVersion":1', '"schemaVersion":1,"schema\\u0056ersion":1'),
    raw.replace('"displayName":', '"displayName":"duplicate","displayName":')]) {
    assert.equal(validateCreatorPluginManifest(value).valid, false, 'Duplicate keys cannot disappear during JSON normalization.');
  }
  assert.equal(validateCreatorPluginManifest(' '.repeat(CREATOR_PLUGIN_MANIFEST_MAX_BYTES + 1)).issues[0].code, 'CREATOR_MANIFEST_LIMIT');
  assert.equal(validateCreatorPluginManifest(JSON.stringify(changed('interface.logo', './assets/logo.png'))).issues[0].path, 'interface.logo');

  // Verify the exported shared workflow constraints remain equivalent to their pre-schema-export rules.
  const samples = ['', '.', '..', 'one', 'one/two', './one', '../one', 'a/../b', 'a//b', '/a', 'C:a', 'a\\b',
    ' a', 'a ', 'a\n', 'a\u2028b\u00a0', 'a\u2028/../b', 'a\u2028//b', 'a:b', 'a\u00a0b', 'a\u2028b'];
  for (const value of samples) {
    const oldRef = value.length >= 1 && value.length <= 128 && value === value.trim() && !/[\u0000-\u0020\u007f/\\:]/u.test(value);
    assert.equal(workflowManifestV1Schema.safeParse({ version: 1, integrationCapabilities: [{ id: 'a', application: 'a',
      alternatives: [{ source: 'mcp', connector: value }] }] }).success, oldRef, `Reference rule drift for ${JSON.stringify(value)}.`);
    const oldPath = value.length >= 1 && value.length <= 256 && !/^[A-Za-z]:/u.test(value) && !value.startsWith('/')
      && !/[\\\u0000-\u001f\u007f]/u.test(value) && !value.split('/').some(segment => segment === '..' || segment === '');
    assert.equal(workflowMcpConnectorDescriptorSchema.safeParse({ name: 'valid', configPath: value }).success, oldPath,
      `Path rule drift for ${JSON.stringify(value)}.`);
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-creator-manifest-'));
  const write = async (relative: string, bytes: string) => {
    const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes);
  };
  try {
    await write('skills/research/SKILL.md', '---\nname: research\ndescription: Research fixture.\nmetadata:\n  version: "1.0.0"\n---\n\n# Research\nUse the selected authorized research source.\n');
    await write('SKILL.md', '---\nname: research\ndescription: Research fixture.\nmetadata:\n  version: "1.0.0"\n---\n\n# Research\n');
    await write('connectors/research.json', '{"mcpServers":{"research":{"url":"https://research.example.test/mcp"}}}');
    await write('assets/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>Research</title><desc>Research fixture</desc><path d="M2 2h20v20H2z"/></svg>');
    for (const value of valid) {
      await write('.canvas-plugin/plugin.json', JSON.stringify(value));
      const result = await validateCanvasPluginPackage(root);
      assert.equal(result.valid, true, result.errors.join(' '));
      assert.equal(result.manifest?.version, value.version, 'Runtime preserves the exact submitted metadata version.');
      assert.equal(result.manifest?.interface?.logo, (value.interface as ObjectValue).logo);
      if (value.workflow) assert.deepEqual(result.manifest?.workflow, parseWorkflowManifest(value.workflow));
    }
    assert.equal((await parseSkillFile(path.join(root, 'skills/research/SKILL.md')))?.version, '1.0.0');
    const legacy = { name: 'legacy-fixture', version: '1.2', description: 'Legacy without Creator metadata.',
      interface: { display_name: 'Legacy' }, connectors: { mcp_servers: './connectors/research.json' } };
    await write('.canvas-plugin/plugin.json', JSON.stringify(legacy));
    assert.equal((await validateCanvasPluginPackage(root)).valid, true, 'Existing legacy package parsing remains unchanged.');
    assert.equal(validateCreatorPluginManifest(JSON.stringify(legacy)).valid, false, 'A newly created package cannot silently use legacy defaults.');
    const guide = await fs.readFile(path.join(process.cwd(), 'seed_skills/create-plugin/references/package-and-connections.md'), 'utf8');
    const example = /```json\n([\s\S]*?)\n```/u.exec(guide)?.[1];
    assert(example && validateCreatorPluginManifest(example).valid, 'The Creator reference example follows the same current server contract.');
    console.log('PASS Creator manifest V1: generated JSON Schema/runtime conformance, strict metadata and paths, shared Workflow V1, duplicate JSON/semantic bounds, actual package parsing, canonical template/guide and legacy compatibility.');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
