import { readFileSync, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';

const requireDependency = createRequire(import.meta.url);

async function assertEmptySceneFixture(directory: string): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (entry.name.toLowerCase().endsWith('.excalidraw')) throw new Error(
      'An archive fixture with Excalidraw scenes must use the native PostgreSQL scene tests.');
    if (entry.isDirectory()) await assertEmptySceneFixture(path.join(directory, entry.name));
  }
}

/** Archive/secret/lock fixtures substitute pg_dump and contain no scene DB.
 * Native scene/checkpoint behavior is covered by excalidraw-existing-clients-test. */
export function loadArchiveServiceFixture<T>(filename: string): T {
  const absolutePath = path.resolve(filename);
  const source = ts.transpileModule(readFileSync(absolutePath, 'utf8'), {
    fileName: absolutePath, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const evaluated = { exports: {} };
  const localRequire = createRequire(absolutePath);
  const load = (name: string) => {
    // These filesystem-only fixtures have no native text state database.
    // Durable text materialization is covered by the real PostgreSQL acceptance suite.
    if (name === '@/app/lib/exports/text-checkpoints') return { ensurePortableTextCheckpointsCurrent: async () => {} };
    if (name === '@/app/lib/db') return { openDb: async () => ({ all: async () => [], close: async () => {} }) };
    if (name === '@/app/lib/excalidraw-collaboration/checkpoint-worker') return {
      ensureExcalidrawCheckpointsCurrent: async () => {
        const root = process.env.DATA ?? process.env.CANVAS_DATA_ROOT;
        if (!root || !path.isAbsolute(root)) throw new Error('The archive fixture requires an isolated absolute data root.');
        await assertEmptySceneFixture(root);
      },
    };
    return name.startsWith('.') ? localRequire(name) : requireDependency(name);
  };
  new Function('require', 'module', 'exports', source)(load, evaluated, evaluated.exports);
  return evaluated.exports as T;
}
