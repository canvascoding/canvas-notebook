import { NextRequest, NextResponse } from 'next/server';
import { parseMultipartFormData } from '@/app/lib/api/form-data';
import {
  fetchMarkdownImageUrl,
  importMarkdownImages,
  MARKDOWN_IMAGE_MAX_FILES,
  type MarkdownImageImportInput,
} from '@/app/lib/markdown/markdown-image-import';
import { parseUploadConvertParams } from '@/app/lib/images/upload-conversion';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

export const runtime = 'nodejs';

function isUploadFile(value: FormDataEntryValue): value is File {
  return value instanceof File && value.size > 0;
}

export async function POST(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canWrite' });
  if (workspaceResult.response) return workspaceResult.response;
  const fileOptions = workspaceFileOptions(workspaceResult.workspace);

  try {
    const limited = rateLimit(request, {
      limit: 80,
      windowMs: 60_000,
      keyPrefix: 'markdown-images-import',
    });
    if (!limited.ok) return limited.response;

    const parsedFormData = await parseMultipartFormData(request);
    if (!parsedFormData.ok) return parsedFormData.response;

    const formData = parsedFormData.formData;
    const files = formData.getAll('files').filter(isUploadFile);
    const remoteUrl = formData.get('url')?.toString().trim();
    const markdownFilePath = formData.get('markdownPath')?.toString() || undefined;
    const targetDir = formData.get('targetDir')?.toString() || undefined;
    const convertParamsRaw = formData.get('convertParams')?.toString();

    if (files.length === 0 && !remoteUrl) {
      return NextResponse.json({ success: false, error: 'Image file or URL is required.' }, { status: 400 });
    }

    if (files.length + (remoteUrl ? 1 : 0) > MARKDOWN_IMAGE_MAX_FILES) {
      return NextResponse.json(
        { success: false, error: `Maximum ${MARKDOWN_IMAGE_MAX_FILES} images can be imported at once.` },
        { status: 400 },
      );
    }

    const parsedConvertParams = parseUploadConvertParams(convertParamsRaw, files.length);
    if (!parsedConvertParams.ok) {
      return NextResponse.json({ success: false, error: parsedConvertParams.error }, { status: 400 });
    }

    const images: MarkdownImageImportInput[] = await Promise.all(files.map(async (file, index) => ({
      buffer: Buffer.from(await file.arrayBuffer()),
      convertParams: parsedConvertParams.params?.[index] ?? null,
      filename: file.name,
      mimeType: file.type || undefined,
      sourceName: file.name,
    })));

    if (remoteUrl) {
      images.push(await fetchMarkdownImageUrl(remoteUrl));
    }

    const imported = await importMarkdownImages({
      images,
      markdownFilePath,
      targetDir,
      fileOptions,
    });

    return NextResponse.json({ success: true, files: imported });
  } catch (error) {
    console.error('[API] Markdown image import failed:', error);
    const message = error instanceof Error ? error.message : 'Failed to import markdown image.';
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
