import type { NextRequest } from 'next/server';
import { handleApiKeyWorkspaceMoveHttp } from '@/app/lib/documents/path-http';

export const runtime = 'nodejs';
export async function POST(request: NextRequest) { return handleApiKeyWorkspaceMoveHttp(request); }
