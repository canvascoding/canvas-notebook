import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const STATE = 'state-value-must-never-appear-in-diagnostics';
const CLIENT_ID = 'client-id-must-never-appear-in-diagnostics';

function serialize(args: unknown[]): string {
  return args.map((value) => {
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  }).join(' ');
}

async function main(): Promise<void> {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'canvas-mcp-server-diagnostics-'));
  const previousData = process.env.DATA;
  process.env.DATA = dataRoot;

  const {
    beginDirectMcpDiagnostic,
    completeDirectMcpDiagnostic,
    failDirectMcpDiagnostic,
    recordDirectMcpOAuthProviderError,
    runWithDirectMcpDiagnostic,
    withDirectMcpRequestId,
  } = await import('../app/lib/mcp/server/diagnostics');
  const { listRecentDirectMcpRequestHistory } = await import('../app/lib/mcp/server/request-history');
  const originalInfo = console.info;
  const originalError = console.error;
  const captured: string[] = [];
  console.info = (...args: unknown[]) => captured.push(serialize(args));
  console.error = (...args: unknown[]) => captured.push(serialize(args));

  try {
    const request = new Request(
      `https://notebook.example.test/api/auth/oauth2/authorize?client_id=${CLIENT_ID}&state=${STATE}`,
    );
    const diagnostics = beginDirectMcpDiagnostic(request, 'oauth.authorization');
    assert.match(diagnostics.requestId, /^[0-9a-f-]{36}$/iu);
    assert.match(diagnostics.flowRef || '', /^[a-f0-9]{24}$/u);

    await completeDirectMcpDiagnostic(diagnostics, {
      statusCode: 302,
      code: 'OAUTH_REQUEST_COMPLETED',
      startedAt: Date.now() - 1,
    });

    const response = withDirectMcpRequestId(
      Response.json({ ok: true }),
      diagnostics.requestId,
    );
    assert.equal(response.headers.get('x-request-id'), diagnostics.requestId);

    const providerSecret = 'provider-error-must-never-appear-in-diagnostics';
    const providerDiagnostics = beginDirectMcpDiagnostic(
      new Request('https://notebook.example.test/api/auth/oauth2/register', { method: 'POST' }),
      'oauth.registration',
    );
    await runWithDirectMcpDiagnostic(providerDiagnostics, async () => {
      recordDirectMcpOAuthProviderError(
        new Error(`relation oauth_client does not exist: ${providerSecret}`),
      );
    });
    await completeDirectMcpDiagnostic(providerDiagnostics, {
      statusCode: 503,
      code: 'OAUTH_PROVIDER_ERROR',
      startedAt: Date.now() - 1,
    });
    const consentDiagnostics = beginDirectMcpDiagnostic(
      new Request('https://notebook.example.test/api/auth/oauth2/consent/redirect', { method: 'POST' }),
      'oauth.consent',
    );
    await completeDirectMcpDiagnostic(consentDiagnostics, {
      statusCode: 303,
      code: 'OAUTH_CONSENT_REDIRECT_ISSUED',
      startedAt: Date.now() - 1,
    });
    const tokenDiagnostics = beginDirectMcpDiagnostic(
      new Request('https://notebook.example.test/api/auth/oauth2/token', { method: 'POST' }),
      'oauth.token',
    );
    await completeDirectMcpDiagnostic(tokenDiagnostics, {
      statusCode: 200,
      code: 'OAUTH_TOKEN_EXCHANGE_COMPLETED',
      startedAt: Date.now() - 1,
    });
    const failedDiagnostics = beginDirectMcpDiagnostic(
      new Request('https://notebook.example.test/mcp', { method: 'POST' }),
      'mcp.http',
    );
    await failDirectMcpDiagnostic(failedDiagnostics, {
      statusCode: 503,
      code: 'MCP_INTERNAL_ERROR',
      startedAt: Date.now() - 1,
    });

    const output = captured.join('\n');
    assert.equal(output.includes(STATE), false);
    assert.equal(output.includes(CLIENT_ID), false);
    assert.equal(output.includes(diagnostics.flowRef || ''), true);
    assert.equal(output.includes('MCP_INTERNAL_ERROR'), true);
    assert.equal(output.includes('OAUTH_PERSISTENCE_SCHEMA_ERROR'), true);
    assert.equal(output.includes('OAUTH_CONSENT_REDIRECT_ISSUED'), true);
    assert.equal(output.includes('OAUTH_TOKEN_EXCHANGE_COMPLETED'), true);
    assert.equal(output.includes(providerSecret), false);

    const history = await listRecentDirectMcpRequestHistory();
    assert.equal(history.length, 5);
    assert.equal(history.some((entry) => entry.code === 'OAUTH_PERSISTENCE_SCHEMA_ERROR'), true);
    assert.equal(history.some((entry) => entry.code === 'MCP_INTERNAL_ERROR'), true);
    assert.equal(history.some((entry) => entry.requestId === diagnostics.requestId), true);
    assert.equal(history.some((entry) => entry.phase === 'oauth.consent'), true);
    assert.equal(history.some((entry) => entry.phase === 'oauth.token'), true);
    assert.equal(JSON.stringify(history).includes(STATE), false);
    assert.equal(JSON.stringify(history).includes(CLIENT_ID), false);
    assert.equal(JSON.stringify(history).includes(providerSecret), false);
  } finally {
    console.info = originalInfo;
    console.error = originalError;
    if (previousData === undefined) delete process.env.DATA;
    else process.env.DATA = previousData;
    await rm(dataRoot, { recursive: true, force: true });
  }

  console.log('mcp-server-diagnostics-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
