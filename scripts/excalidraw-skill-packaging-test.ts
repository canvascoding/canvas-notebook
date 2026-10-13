import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { parseExcalidrawEditInput } from '../app/lib/excalidraw-collaboration/api-contract';
import { validateCanvasPluginPackage } from '../app/lib/plugins/canvas-plugin-manifest';
import { computeCanvasPluginChecksum } from '../app/lib/plugins/canvas-plugin-registry';

const root = process.cwd();
const skillRoot = path.join(root, 'seed_skills/excalidraw-diagram');
const validator = path.join(skillRoot, 'scripts/validate_excalidraw.py');
const rectangle = { id: 'existing_shape', type: 'rectangle', x: 0, y: 0, width: 220, height: 100,
  angle: 0, strokeColor: '#1f2937', backgroundColor: '#e0f2fe', fillStyle: 'solid', strokeWidth: 2,
  strokeStyle: 'solid', roughness: 1, opacity: 100, seed: 101, version: 4, versionNonce: 209,
  isDeleted: false, groupIds: [], boundElements: null, link: null, locked: false };
const scene = { documentId: 'skill-test-document', workspaceId: 'skill-test-workspace', path: 'diagram.excalidraw',
  lifecycleGeneration: 2, sceneSequence: 7, status: 'active', elements: [rectangle], appState: {}, assets: [] };
const request = { documentId: scene.documentId, lifecycleGeneration: scene.lifecycleGeneration,
  observedSceneSequence: scene.sceneSequence, idempotencyKey: 'logical-edit-1', actions: [
    { type: 'update', elementId: rectangle.id, expectedVersion: rectangle.version,
      expectedVersionNonce: rectangle.versionNonce, element: { ...rectangle, x: 80 } },
    { type: 'create', element: { ...rectangle, id: 'new_shape', version: 1, versionNonce: 102, x: 400 } },
  ] };

function splitSkill(text: string): { metadata: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(text);
  assert(match, 'Skill must have YAML frontmatter');
  return { metadata: YAML.parse(match[1]) as Record<string, unknown>, body: text.slice(match[0].length) };
}

async function main(): Promise<void> {
  const markdown = await fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
  const { metadata, body } = splitSkill(markdown);
  assert.equal(metadata.name, 'excalidraw-diagram');
  assert.equal((metadata.metadata as Record<string, string>).version, '1.4.0');
  assert.equal(metadata.license, 'Canvas Notebook Sustainable Use License');
  assert.match(String(metadata.compatibility), /PostgreSQL/);
  for (const name of ['create_excalidraw_scene', 'get_excalidraw_scene', 'edit_excalidraw_scene']) assert(body.includes(name));
  assert.match(body, /activation or compatibility error/);
  assert.match(body, /Never create or change.*generic write\/edit\/patch.*shell, Python, Node/);
  assert.match(body, /Never submit a complete scene replacement/);
  assert.match(body, /identical request with the same key/);
  assert.match(body, /new idempotency key/);
  assert.match(body, /disabled by default/);
  assert.match(body, /reviewAvailable: true/);
  assert.match(body, /pending\/failed checkpoint still means the scene is saved in PostgreSQL/);
  assert.match(body, /Return the actual `documentUrl`/);
  assert.doesNotMatch(body, /Write complete Excalidraw JSON|directly in the workspace/);

  const examples = [...body.matchAll(/```json\n([\s\S]*?)\n```/gu)].map(match => JSON.parse(match[1]) as Record<string, unknown>);
  assert.equal(examples.length, 4);
  for (const action of examples.slice(0, 3)) parseExcalidrawEditInput({ ...request, actions: [action] });
  parseExcalidrawEditInput(request);
  const validation = await validateCanvasPluginPackage(path.join(root, 'seed_plugins/document-suite'));
  assert.equal(validation.valid, true, validation.errors.join('\n'));
  assert.equal(validation.manifest?.version, '1.4.0');

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-excalidraw-skill-'));
  try {
    const run = (payload: unknown, mode = '--operation-stdin') => spawnSync(process.env.CANVAS_PYTHON_PATH || 'python3',
      [validator, mode], { input: JSON.stringify(payload), encoding: 'utf8', cwd: temp,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    const good = run({ scene, request });
    assert.equal(good.status, 0, good.stderr || good.stdout);
    const bad = (payload: unknown, error: RegExp) => {
      const result = run(payload);
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.match(result.stderr, error);
    };
    bad({ scene, request: { ...request, actorUserId: 'spoof' } }, /no actor/);
    bad({ scene, request: { ...request, documentId: 'wrong-identity' } }, /documentId differs/);
    bad({ scene, request: { ...request, lifecycleGeneration: 1 } }, /lifecycleGeneration differs/);
    bad({ scene, request: { ...request, observedSceneSequence: 6 } }, /observedSceneSequence differs/);
    bad({ scene, request: { ...request, path: 'other.excalidraw' } }, /path does not identify/);
    bad({ scene, request: { ...request, workspaceId: 'another-workspace' } }, /workspaceId does not identify/);
    bad({ scene, request: { ...request, idempotencyKey: '' } }, /idempotencyKey/);
    bad({ scene, request: { ...request, actions: [{ ...request.actions[0], expectedVersionNonce: 210 }] } }, /expectedVersionNonce is stale/);
    bad({ scene, request: { ...request, actions: [request.actions[0], request.actions[0]] } }, /more than once/);
    bad({ scene, request: { ...request, actions: [{ type: 'create', element: rectangle }] } }, /reuses existing or deleted ID/);
    bad({ scene, request: { ...request, actions: [{ type: 'create', element: { ...rectangle, id: 'invalid/id' } }] } }, /invalid target ID/);
    bad({ scene, request: { ...request, actions: [{ type: 'create', element: { ...rectangle, id: 'label', type: 'text',
      text: 'Label', originalText: 'Label', fontSize: 20, fontFamily: 5, lineHeight: 1.25, containerId: 'missing-container' } }] } }, /missing element id/);
    bad({ scene, request: { ...request, actions: [{ type: 'create', element: { ...rectangle, id: 'picture', type: 'image', fileId: 'absent-asset' } }] } }, /missing image asset/);
    bad({ scene, request: { ...request, actions: [{ type: 'create', element: { ...rectangle, id: 'deleted-picture', type: 'image', isDeleted: true, fileId: 'absent-asset' } }] } }, /must be live/);
    bad({ scene, request: { ...request, actions: [{ type: 'create', element: { ...rectangle, id: 'bad-group', groupIds: ['bad/id'] } }] } }, /valid element IDs/);
    bad({ scene, request: { ...request, actions: [{ type: 'create', element: { ...rectangle, id: 'bad-version', version: true } }] } }, /positive safe integer/);
    bad({ scene, request: { ...request, actions: Array.from({ length: 501 }, (_, index) => ({ type: 'create', element: { ...rectangle, id: `shape_${index}` } })) } }, /1–500 actions/);
    bad({ scene, request: { ...request, actions: [{ type: 'create', element: { ...rectangle, id: 'large', customData: 'x'.repeat(1024 * 1024) } }] } }, /exceeds 1 MiB/);
    const existingImage = run({ scene: { ...scene, assets: [{ fileId: 'real-asset' }] }, request: { ...request,
      actions: [{ type: 'create', element: { ...rectangle, id: 'picture', type: 'image', fileId: 'real-asset' } }] } });
    assert.equal(existingImage.status, 0, existingImage.stderr);
    const deleteResult = run({ scene, request: { ...request, actions: [{ type: 'delete', elementId: rectangle.id,
      expectedVersion: 4, expectedVersionNonce: 209 }] } });
    assert.equal(deleteResult.status, 0, deleteResult.stderr);
    const portable = run({ type: 'excalidraw', version: 2, source: 'canvas-notebook', elements: [rectangle], appState: {}, files: {} }, '--stdin');
    assert.equal(portable.status, 0, portable.stderr);
    const oversizedNumber = spawnSync(process.env.CANVAS_PYTHON_PATH || 'python3', [validator, '--operation-stdin'], {
      input: JSON.stringify({ scene, request: { ...request, actions: [{ type: 'create', element: { ...rectangle, id: 'huge-number', x: 'TOO_LARGE_NUMBER' } }] } })
        .replace('"TOO_LARGE_NUMBER"', `1${'0'.repeat(400)}`), encoding: 'utf8', cwd: temp,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    assert.equal(oversizedNumber.status, 1);
    assert.match(oversizedNumber.stderr, /must be a finite number/);
    assert.doesNotMatch(oversizedNumber.stderr, /Traceback/);
    assert.deepEqual(await fs.readdir(temp), [], 'stdin validation must not create any files');
  } finally { await fs.rm(temp, { recursive: true, force: true }); }

  const marketplaceFlag = process.argv.indexOf('--marketplace-root');
  if (marketplaceFlag >= 0) {
    const marketplaceRoot = process.argv[marketplaceFlag + 1];
    assert(marketplaceRoot, '--marketplace-root needs a checkout path');
    const packageRoot = path.join(marketplaceRoot, 'plugins/document-suite/1.4.0');
    const packageValidation = await validateCanvasPluginPackage(packageRoot);
    assert.equal(packageValidation.valid, true, packageValidation.errors.join('\n'));
    const published = splitSkill(await fs.readFile(path.join(packageRoot, 'skills/excalidraw-diagram/SKILL.md'), 'utf8'));
    assert.equal(published.body, body);
    assert.equal(published.metadata.license, 'MIT');
    assert.notDeepEqual(published.metadata.metadata, metadata.metadata, 'distribution provenance must stay separate');
    for (const helper of ['scripts/validate_excalidraw.py', 'agents/canvas.yaml']) {
      assert.deepEqual(await fs.readFile(path.join(packageRoot, 'skills/excalidraw-diagram', helper)), await fs.readFile(path.join(skillRoot, helper)));
    }
    const receipt = JSON.parse(await fs.readFile(path.join(marketplaceRoot, 'prepared/document-suite-1.4.0.json'), 'utf8')) as {
      checksum: string; seed: { pluginChecksum: string; skillChecksum: string };
    };
    assert.equal(receipt.checksum, `sha256:${await computeCanvasPluginChecksum(packageRoot)}`);
    assert.equal(receipt.seed.pluginChecksum, `sha256:${await computeCanvasPluginChecksum(path.join(root, 'seed_plugins/document-suite'))}`);
    assert.equal(receipt.seed.skillChecksum, `sha256:${await computeCanvasPluginChecksum(skillRoot)}`);
    const verify = spawnSync(process.execPath, [path.join(marketplaceRoot, 'scripts/document-suite-release.mjs'), 'verify', '--notebook-root', root], { encoding: 'utf8' });
    assert.equal(verify.status, 0, verify.stderr || verify.stdout);
    console.log('Excalidraw Marketplace package validates with production Canvas checksum and manifest rules');
  }
  console.log('excalidraw-skill-packaging-test: passed (Scene-Service actions, read-only stdin, metadata and optional cross-repo parity)');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
