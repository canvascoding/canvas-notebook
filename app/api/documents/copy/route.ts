import type { NextRequest } from 'next/server';
import { handleApiKeyWorkspaceCopyHttp } from '@/app/lib/documents/copy-http';

export const runtime = 'nodejs';
export async function POST(request: NextRequest) { return handleApiKeyWorkspaceCopyHttp(request); }
