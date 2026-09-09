import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const binding = {
  ownerUserId: 'user-a',
  organizationId: 'org-a',
  connectionId: 'connection-a',
  purpose: 'oauth-token',
};

function key(): string {
  return crypto.randomBytes(32).toString('base64url');
}

async function expectRejects(action: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(action, (error: unknown) => pattern.test(error instanceof Error ? error.message : String(error)));
}

async function main() {
  const mutableEnv = process.env as Record<string, string | undefined>;
  const originalMasterKey = process.env.INTEGRATIONS_ENV_MASTER_KEY;
  const originalPreviousKeys = process.env.MCP_CREDENTIAL_PREVIOUS_KEYS;
  const originalDataRoot = process.env.CANVAS_DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'canvas-mcp-secret-store-'));
  mutableEnv.CANVAS_DATA_ROOT = dataRoot;
  delete mutableEnv.MCP_CREDENTIAL_PREVIOUS_KEYS;
  mutableEnv.INTEGRATIONS_ENV_MASTER_KEY = key();

  try {
    const { openMcpSecret, sealMcpSecret } = await import('../app/lib/mcp/secret-store');
    const payload = { accessToken: 'secret-token', refreshToken: 'refresh-token' };
    const first = await sealMcpSecret(payload, binding);
    const second = await sealMcpSecret(payload, binding);
    assert.notEqual(first, second, 'AES-GCM envelopes must use a fresh IV');
    assert.equal(first.includes('secret-token'), false, 'the envelope must not contain plaintext');
    assert.deepEqual(await openMcpSecret<typeof payload>(first, binding), payload);

    const envelope = JSON.parse(first) as Record<string, string | number>;
    assert.equal(envelope.version, 1);
    assert.equal(typeof envelope.keyId, 'string');
    assert.equal(typeof envelope.iv, 'string');
    assert.equal(typeof envelope.tag, 'string');
    assert.equal(typeof envelope.ciphertext, 'string');

    const ciphertext = String(envelope.ciphertext);
    const tampered = JSON.stringify({ ...envelope, ciphertext: `${ciphertext[0] === 'A' ? 'B' : 'A'}${ciphertext.slice(1)}` });
    await expectRejects(() => openMcpSecret(tampered, binding), /authenticated|binding/i);
    await expectRejects(() => openMcpSecret(first, { ...binding, ownerUserId: 'user-b' }), /authenticated|binding/i);
    await expectRejects(() => openMcpSecret(first, { ...binding, organizationId: 'org-b' }), /authenticated|binding/i);
    await expectRejects(() => openMcpSecret(first, { ...binding, connectionId: 'connection-b' }), /authenticated|binding/i);
    await expectRejects(() => openMcpSecret(first, { ...binding, purpose: 'different-purpose' }), /authenticated|binding/i);

    const oldKey = process.env.INTEGRATIONS_ENV_MASTER_KEY!;
    const oldEnvelope = await sealMcpSecret(payload, binding);
    mutableEnv.INTEGRATIONS_ENV_MASTER_KEY = key();
    mutableEnv.MCP_CREDENTIAL_PREVIOUS_KEYS = JSON.stringify([oldKey]);
    assert.deepEqual(await openMcpSecret<typeof payload>(oldEnvelope, binding), payload);
    const rotatedEnvelope = await sealMcpSecret(payload, binding);
    assert.notEqual(JSON.parse(rotatedEnvelope).keyId, JSON.parse(oldEnvelope).keyId);
    assert.deepEqual(await openMcpSecret<typeof payload>(rotatedEnvelope, binding), payload);

    await expectRejects(() => openMcpSecret('{"accessToken":"plaintext"}', binding), /envelope/i);
    await expectRejects(
      () => openMcpSecret(JSON.stringify({ version: 2, keyId: envelope.keyId, iv: envelope.iv, tag: envelope.tag, ciphertext: envelope.ciphertext }), binding),
      /version/i,
    );

    delete mutableEnv.INTEGRATIONS_ENV_MASTER_KEY;
    delete mutableEnv.MCP_CREDENTIAL_PREVIOUS_KEYS;
    const configuredKey = key();
    const integrationsDir = path.join(dataRoot, 'secrets');
    await mkdir(integrationsDir, { recursive: true });
    await writeFile(path.join(integrationsDir, 'Canvas-Integrations.env'), `MCP_CREDENTIAL_KEY=${configuredKey}\n`);
    const centrallyConfigured = await sealMcpSecret(payload, binding);
    assert.deepEqual(await openMcpSecret<typeof payload>(centrallyConfigured, binding), payload);
    const rotatedConfiguredKey = key();
    await writeFile(
      path.join(integrationsDir, 'Canvas-Integrations.env'),
      `MCP_CREDENTIAL_KEY=${rotatedConfiguredKey}\nMCP_CREDENTIAL_PREVIOUS_KEYS=${JSON.stringify([configuredKey])}\n`,
    );
    assert.deepEqual(await openMcpSecret<typeof payload>(centrallyConfigured, binding), payload);

    await rm(integrationsDir, { recursive: true, force: true });
    await expectRejects(() => sealMcpSecret(payload, binding), /settings\?tab=integrations/i);
    await expectRejects(() => openMcpSecret(first, binding), /settings\?tab=integrations/i);

    console.log('mcp-secret-store-test: ok');
  } finally {
    if (originalMasterKey === undefined) delete mutableEnv.INTEGRATIONS_ENV_MASTER_KEY;
    else mutableEnv.INTEGRATIONS_ENV_MASTER_KEY = originalMasterKey;
    if (originalPreviousKeys === undefined) delete mutableEnv.MCP_CREDENTIAL_PREVIOUS_KEYS;
    else mutableEnv.MCP_CREDENTIAL_PREVIOUS_KEYS = originalPreviousKeys;
    if (originalDataRoot === undefined) delete mutableEnv.CANVAS_DATA_ROOT;
    else mutableEnv.CANVAS_DATA_ROOT = originalDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
