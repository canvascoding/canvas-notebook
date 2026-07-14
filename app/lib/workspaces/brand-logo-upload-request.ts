import 'server-only';

import { NextResponse } from 'next/server';

import { parseMultipartFormData } from '@/app/lib/api/form-data';
import { WORKSPACE_BRAND_LOGO_MAX_UPLOAD_BYTES } from './brand-logo-service';

const MULTIPART_OVERHEAD_ALLOWANCE_BYTES = 64 * 1024;

type BrandLogoUploadResult =
  | { ok: true; buffer: Buffer }
  | { ok: false; response: NextResponse };

export async function readBrandLogoUpload(request: Request): Promise<BrandLogoUploadResult> {
  const contentLength = Number(request.headers.get('content-length'));
  if (
    Number.isFinite(contentLength)
    && contentLength > WORKSPACE_BRAND_LOGO_MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_ALLOWANCE_BYTES
  ) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: 'Logo file is too large. Maximum size is 1 MB.' },
        { status: 413 },
      ),
    };
  }

  const parsed = await parseMultipartFormData(request);
  if (!parsed.ok) return parsed;

  const files = parsed.formData.getAll('file').filter((value): value is File => value instanceof File);
  if (files.length !== 1) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: 'Upload exactly one logo file.' },
        { status: 400 },
      ),
    };
  }

  const file = files[0];
  if (file.size > WORKSPACE_BRAND_LOGO_MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: 'Logo file is too large. Maximum size is 1 MB.' },
        { status: 413 },
      ),
    };
  }

  return { ok: true, buffer: Buffer.from(await file.arrayBuffer()) };
}
