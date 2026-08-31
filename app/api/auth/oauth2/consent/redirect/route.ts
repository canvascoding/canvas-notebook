import { auth } from '@/app/lib/auth';
import { completeDirectMcpOAuthConsentRedirect } from '@/app/lib/mcp/server/oauth-consent-redirect';
import {
  beginDirectMcpDiagnostic,
  completeDirectMcpDiagnostic,
  failDirectMcpDiagnostic,
  runWithDirectMcpDiagnostic,
  withDirectMcpRequestId,
} from '@/app/lib/mcp/server/diagnostics';

export async function POST(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const diagnostics = beginDirectMcpDiagnostic(request, 'oauth.consent');
  try {
    const response = withDirectMcpRequestId(
      await runWithDirectMcpDiagnostic(
        diagnostics,
        () => completeDirectMcpOAuthConsentRedirect(request, auth.handler),
      ),
      diagnostics.requestId,
    );
    await completeDirectMcpDiagnostic(diagnostics, {
      statusCode: response.status,
      code: response.status === 303
        ? 'OAUTH_CONSENT_REDIRECT_ISSUED'
        : response.status >= 500
          ? 'OAUTH_CONSENT_SERVICE_UNAVAILABLE'
          : 'OAUTH_CONSENT_REJECTED',
      startedAt,
    });
    return response;
  } catch {
    await failDirectMcpDiagnostic(diagnostics, {
      statusCode: 503,
      code: 'OAUTH_CONSENT_INTERNAL_ERROR',
      startedAt,
    });
    return withDirectMcpRequestId(Response.json({
      error: 'temporarily_unavailable',
      error_description: 'The OAuth consent service is temporarily unavailable.',
    }, {
      status: 503,
      headers: {
        'cache-control': 'no-store',
        pragma: 'no-cache',
      },
    }), diagnostics.requestId);
  }
}
