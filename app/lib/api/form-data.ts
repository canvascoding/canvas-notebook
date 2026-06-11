import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

export const FORMDATA_PARSE_ERROR_CODE = 'FORMDATA_PARSE_ERROR';

const FORMDATA_PARSE_ERROR_MESSAGE = 'Failed to parse upload data. Please try again.';

type ParseMultipartFormDataResult =
  | { ok: true; formData: FormData }
  | { ok: false; response: NextResponse };

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getRequestUrlForLogs(request: Request): string {
  try {
    const url = new URL(request.url);
    return `${url.origin}${url.pathname}`;
  } catch {
    return request.url;
  }
}

export async function parseMultipartFormData(request: Request): Promise<ParseMultipartFormDataResult> {
  try {
    return { ok: true, formData: await request.formData() };
  } catch (parseError) {
    const diagnostics = {
      code: FORMDATA_PARSE_ERROR_CODE,
      error: getErrorMessage(parseError),
      contentType: request.headers.get('content-type') ?? 'unknown',
      contentLength: request.headers.get('content-length') ?? 'unknown',
      method: request.method,
      url: getRequestUrlForLogs(request),
    };

    console.error('[API] Failed to parse FormData body:', diagnostics);

    Sentry.withScope((scope) => {
      scope.setLevel('warning');
      scope.setTag('error_code', FORMDATA_PARSE_ERROR_CODE);
      scope.setTag('request_method', diagnostics.method);
      scope.setContext('formDataParse', diagnostics);
      scope.setFingerprint([FORMDATA_PARSE_ERROR_CODE, diagnostics.method, diagnostics.url]);
      Sentry.captureException(parseError);
    });

    return {
      ok: false,
      response: NextResponse.json(
        {
          success: false,
          error: FORMDATA_PARSE_ERROR_MESSAGE,
          code: FORMDATA_PARSE_ERROR_CODE,
        },
        { status: 400 },
      ),
    };
  }
}
