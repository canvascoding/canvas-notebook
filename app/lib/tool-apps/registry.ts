import 'server-only';

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AUTOMATION_APP_URI, TODO_APP_URI, type BuiltinToolAppDescriptor } from './types';

/** Fixed build artifacts only: provider data never becomes a filesystem path. */
export async function readBuiltinToolAppResource(app: BuiltinToolAppDescriptor): Promise<string> {
  const artifact = { [AUTOMATION_APP_URI]: 'automation-job-v1.html', [TODO_APP_URI]: 'human-todo-v1.html' }[app.resourceUri];
  if (!artifact) throw new Error('Unknown Canvas widget.');
  return readFile(path.join(process.cwd(), 'public', '_canvas-tool-apps', artifact), 'utf8');
}
