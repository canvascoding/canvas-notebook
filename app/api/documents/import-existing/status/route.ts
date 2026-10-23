import type { NextRequest } from 'next/server';
import { handleMarkdownOriginalImportHttp } from '@/app/lib/documents/original-markdown-import-http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  return handleMarkdownOriginalImportHttp(request, 'status');
}
