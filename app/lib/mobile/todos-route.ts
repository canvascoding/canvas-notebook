import 'server-only';

import { NextResponse } from 'next/server';

import { jsonServerError } from '@/app/lib/api/route-helpers';
import { TodoStoreError } from '@/app/lib/todos/store';

import { MobileTodoError } from './todos';

export const mobileTodosResponseHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  Vary: 'Cookie, X-Canvas-Workspace-Id',
  'X-Content-Type-Options': 'nosniff',
};

export function mobileTodosErrorResponse(error: unknown, context: string) {
  if (error instanceof MobileTodoError) {
    return NextResponse.json(
      { success: false, code: error.code, error: error.message },
      { status: error.status, headers: mobileTodosResponseHeaders },
    );
  }
  if (error instanceof TodoStoreError) {
    const status = error.code === 'TODO_NOT_FOUND' || error.code === 'CATEGORY_NOT_FOUND' || error.code === 'ASSIGNEE_NOT_FOUND'
      ? 404
      : error.code === 'ORGANIZATION_ACCESS_DENIED' ? 403 : 400;
    return NextResponse.json(
      { success: false, code: error.code, error: error.message },
      { status, headers: mobileTodosResponseHeaders },
    );
  }
  return jsonServerError(context, error, 'To-do request failed.');
}
