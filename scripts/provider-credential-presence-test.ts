import assert from 'node:assert/strict';
import { findStoredCredentialScope } from '../app/components/settings/ai-runtime/credential-presence-client';

async function main() {
  const originalFetch = globalThis.fetch;
  const input = { requiredKeys: ['OPENAI_API_KEY'], scopes: ['system', 'organization', 'user'] as const, preferredScope: 'system' as const, signal: new AbortController().signal };
  let denied = false;
  let unreadable = false;
  let fail = false;
  globalThis.fetch = async (url, init) => {
    assert.equal(init?.cache, 'no-store');
    assert.equal(new URL(String(url), 'http://localhost').searchParams.get('metadataOnly'), '1');
    const scope = new URL(String(url), 'http://localhost').searchParams.get('secretScope');
    if (scope === 'system' && denied) return Response.json({ success: false }, { status: 403 });
    if (fail) throw new Error('network failed');
    return Response.json({ success: true, data: { entries: scope === 'user' ? [{ key: 'OPENAI_API_KEY', configured: !unreadable, readable: !unreadable }] : [] } });
  };
  try {
    assert.equal(await findStoredCredentialScope(input), 'user');
    denied = true;
    assert.equal(await findStoredCredentialScope(input), 'user', 'a forbidden broader scope is never read as fallback');
    assert.equal(await findStoredCredentialScope({ ...input, requiredKeys: ['OTHER_REQUIRED_KEY'] }), null);
    unreadable = true;
    await assert.rejects(() => findStoredCredentialScope(input), /not readable/);
    unreadable = false; fail = true;
    await assert.rejects(() => findStoredCredentialScope(input), /network failed/);
    fail = false;
    const controller = new AbortController(); controller.abort();
    await assert.rejects(() => findStoredCredentialScope({ ...input, signal: controller.signal }), { name: 'AbortError' });
    console.log('provider-credential-presence-test: ok');
  } finally { globalThis.fetch = originalFetch; }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
