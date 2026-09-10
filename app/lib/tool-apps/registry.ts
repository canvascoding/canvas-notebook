import 'server-only';

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AUTOMATION_APP_URI, type BuiltinToolAppDescriptor } from './types';

/** Fixed build artifacts only: provider data never becomes a filesystem path. */
export async function readBuiltinToolAppResource(app: BuiltinToolAppDescriptor): Promise<string> {
  if (app.resourceUri !== AUTOMATION_APP_URI) throw new Error('Unknown Canvas widget.');
  return readFile(path.join(process.cwd(), 'public', '_canvas-tool-apps', 'automation-job-v1.html'), 'utf8');
}
