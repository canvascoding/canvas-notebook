import assert from 'node:assert/strict';

import {
  beginDirectMcpDiagnostic,
  completeDirectMcpDiagnostic,
  failDirectMcpDiagnostic,
  recordDirectMcpOAuthProviderError,
  runWithDirectMcpDiagnostic,
  withDirectMcpRequestId,
} from '../app/lib/mcp/server/diagnostics';

const STATE = 'state-value-must-never-appear-in-diagnostics';
const CLIENT_ID = 'client-id-must-never-appear-in-diagnostics';

function serialize(args: unknown[]): string {
  return args.map((value) => {
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  }).join(' ');
}

async function main(): Promise<void> {
  const originalInfo = console.info;
  const originalError = console.error;
  const captured: string[] = [];
  console.info = (...args: unknown[]) => captured.push(serialize(args));
  console.error = (...args: unknown[]) => captured.push(serialize(args));

  try {
    const request = new Request(
      `https://notebook.example.test/api/auth/oauth2/authorize?client_id=${CLIENT_ID}&state=${STATE}`,
    );
    const diagnostics = beginDirectMcpDiagnostic(request, 'oauth.request');
    assert.match(diagnostics.requestId, /^[0-9a-f-]{36}$/iu);
    assert.match(diagnostics.flowRef || '', /^[a-f0-9]{24}$/u);

    completeDirectMcpDiagnostic(diagnostics, {
      statusCode: 302,
      code: 'OAUTH_REQUEST_COMPLETED',
      startedAt: Date.now() - 1,
    });
    failDirectMcpDiagnostic(diagnostics, {
      statusCode: 503,
      code: 'OAUTH_INTERNAL_ERROR',
      startedAt: Date.now() - 1,
    });

    const response = withDirectMcpRequestId(
      Response.json({ ok: true }),
      diagnostics.requestId,
    );
    assert.equal(response.headers.get('x-request-id'), diagnostics.requestId);

    const providerSecret = 'provider-error-must-never-appear-in-diagnostics';
    await runWithDirectMcpDiagnostic(diagnostics, async () => {
      recordDirectMcpOAuthProviderError(
        new Error(`relation oauth_client does not exist: ${providerSecret}`),
      );
    });

    const output = captured.join('\n');
    assert.equal(output.includes(STATE), false);
    assert.equal(output.includes(CLIENT_ID), false);
    assert.equal(output.includes(diagnostics.flowRef || ''), true);
    assert.equal(output.includes('OAUTH_INTERNAL_ERROR'), true);
    assert.equal(output.includes('OAUTH_PERSISTENCE_SCHEMA_ERROR'), true);
    assert.equal(output.includes(providerSecret), false);
  } finally {
    console.info = originalInfo;
    console.error = originalError;
  }

  console.log('mcp-server-diagnostics-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
