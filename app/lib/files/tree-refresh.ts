import { getDirectoryDepth } from './path-utils';

const DEFAULT_CONCURRENCY = 4;

function uniqueDirectoryPaths(dirPaths: string[], includeRoot: boolean): string[] {
  return Array.from(
    new Set(
      dirPaths
        .map((dirPath) => dirPath || '.')
        .filter((dirPath) => dirPath.trim().length > 0 && (includeRoot || dirPath !== '.')),
    ),
  );
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
) {
  let cursor = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await task(items[index]);
      }
    }),
  );
}

export async function runDirectoryTasksByDepth(
  dirPaths: string[],
  task: (dirPath: string) => Promise<void>,
  options: { concurrency?: number; includeRoot?: boolean } = {},
) {
  const byDepth = new Map<number, string[]>();
  for (const dirPath of uniqueDirectoryPaths(dirPaths, options.includeRoot ?? true)) {
    const depth = getDirectoryDepth(dirPath);
    byDepth.set(depth, [...(byDepth.get(depth) ?? []), dirPath]);
  }

  const depths = Array.from(byDepth.keys()).sort((a, b) => a - b);
  for (const depth of depths) {
    await runWithConcurrency(
      byDepth.get(depth) ?? [],
      options.concurrency ?? DEFAULT_CONCURRENCY,
      task,
    );
  }
}
