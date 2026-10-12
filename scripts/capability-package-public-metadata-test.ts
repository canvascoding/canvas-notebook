import assert from 'node:assert/strict';
import Module from 'node:module';
import { toPublicCapabilityPackageMetadata } from '../app/lib/capabilities/packages/public-metadata';

async function main() {
  const text = '{"storeOrigin":{"fileContent":"must stay byte-for-byte"}}\n';
  const contentBase64 = Buffer.from(text).toString('base64');
  const privateOrigin = { registryIdentity: 'private-source-hash', baselineChecksum: 'private-baseline', upstreamChecksum: 'private-upstream' };
  const input = { version: '100.0.0', checksum: 'ordinary-current-digest', storeOrigin: privateOrigin,
    sourceStamp: { checksum: 'ordinary-source-digest', storeOrigin: privateOrigin },
    files: [{ text, contentBase64, storeOrigin: privateOrigin }],
    failedResult: { success: false, plugin: { name: 'example', storeOrigin: privateOrigin } } };
  const before = structuredClone(input);
  Object.freeze(input); Object.freeze(input.sourceStamp); Object.freeze(input.files[0]); Object.freeze(privateOrigin);
  const publicValue = toPublicCapabilityPackageMetadata(input);
  assert.notEqual(publicValue, input);
  assert.deepEqual(input, before, 'Serialization does not mutate internal metadata or provenance');
  assert.equal(Object.hasOwn(publicValue, 'storeOrigin'), false);
  assert.equal(Object.hasOwn(publicValue.sourceStamp, 'storeOrigin'), false);
  assert.equal(Object.hasOwn(publicValue.files[0], 'storeOrigin'), false);
  assert.equal(Object.hasOwn(publicValue.failedResult.plugin, 'storeOrigin'), false);
  assert.equal(publicValue.version, input.version); assert.equal(publicValue.checksum, input.checksum);
  assert.equal(publicValue.sourceStamp.checksum, input.sourceStamp.checksum);
  assert.equal(publicValue.files[0].text, text); assert.equal(publicValue.files[0].contentBase64, contentBase64);
  assert.equal(Buffer.from(publicValue.files[0].contentBase64, 'base64').toString(), text);
  assert.equal(toPublicCapabilityPackageMetadata(undefined), undefined);
  assert.equal(toPublicCapabilityPackageMetadata(text), text);

  // The real HTTP serializer is exercised. Auth is not invoked by packageResponse;
  // current actor/SQL/package authority remains covered by the actual transport fixture.
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const original = loader._load;
  loader._load = (name, parent, isMain) => name === '@/app/lib/auth' ? {} : original(name, parent, isMain);
  try {
    const { packageResponse } = await import('../app/api/capabilities/packages/http');
    const response = packageResponse({ published: input });
    assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const json = await response.json();
    assert.equal(json.success, true); assert.deepEqual(json.data.published, publicValue);
    assert(!JSON.stringify(json).includes('private-source-hash'));
    assert.equal(json.data.published.files[0].text, text);
    assert.deepEqual(input, before);
  } finally { loader._load = original; }
  console.log('Capability package public metadata and HTTP serialization PASS.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
