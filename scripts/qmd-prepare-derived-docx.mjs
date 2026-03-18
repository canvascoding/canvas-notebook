import fs from 'node:fs/promises';
import path from 'node:path';

import mammoth from 'mammoth';

function directoryExists(targetPath) {
  return fs.stat(targetPath).then((stat) => stat.isDirectory()).catch(() => false);
}

async function resolveCanvasDataRoot(cwd = process.cwd()) {
  const configured = process.env.CANVAS_DATA_ROOT?.trim();
  if (configured) {
    return path.resolve(configured);
  }

  if (await directoryExists('/data')) {
    return '/data';
  }

  return path.resolve(cwd, 'data');
}

async function listFilesRecursive(rootDir, predicate, relativeBase = '') {
  const entries = await fs.readdir(path.join(rootDir, relativeBase), { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    const relativePath = relativeBase ? path.join(relativeBase, entry.name) : entry.name;

    if (entry.isDirectory()) {
      results.push(...await listFilesRecursive(rootDir, predicate, relativePath));
      continue;
    }

    if (predicate(relativePath)) {
      results.push(relativePath);
    }
  }

  return results;
}

function escapeFrontmatter(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function buildDerivedMarkdown(relativePath, text) {
  const fileName = path.basename(relativePath);
  return `---\noriginalPath: "${escapeFrontmatter(relativePath)}"\nsourceType: "workspace-derived"\nsourceFormat: "docx"\n---\n\n# ${fileName}\n\nOriginal workspace path: \`${relativePath}\`\n\n${text.trim()}\n`;
}

async function ensureParentDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function removeEmptyDirs(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);

  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory()) {
      return;
    }

    const entryPath = path.join(rootDir, entry.name);
    await removeEmptyDirs(entryPath);

    const remaining = await fs.readdir(entryPath).catch(() => []);
    if (remaining.length === 0) {
      await fs.rmdir(entryPath).catch(() => undefined);
    }
  }));
}

async function main() {
  const dataRoot = await resolveCanvasDataRoot();
  const workspaceRoot = path.join(dataRoot, 'workspace');
  const derivedRoot = path.join(dataRoot, 'cache', 'qmd', 'derived');
  const derivedDocxRoot = path.join(derivedRoot, 'docx');
  const statusPath = path.join(derivedRoot, 'status.json');

  await fs.mkdir(derivedDocxRoot, { recursive: true });

  const docxFiles = await listFilesRecursive(
    workspaceRoot,
    (relativePath) => relativePath.toLowerCase().endsWith('.docx') && !path.basename(relativePath).startsWith('~$'),
  ).catch(async (error) => {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  });

  const seenDerived = new Set();
  const warnings = [];
  let extractedCount = 0;
  let updatedCount = 0;
  let errorCount = 0;

  for (const relativePath of docxFiles) {
    const sourcePath = path.join(workspaceRoot, relativePath);
    const derivedPath = path.join(derivedDocxRoot, `${relativePath}.md`);
    seenDerived.add(path.normalize(derivedPath));

    try {
      const [sourceStat, derivedStat] = await Promise.all([
        fs.stat(sourcePath),
        fs.stat(derivedPath).catch(() => null),
      ]);

      if (derivedStat && derivedStat.mtimeMs >= sourceStat.mtimeMs) {
        extractedCount += 1;
        continue;
      }

      const result = await mammoth.extractRawText({ path: sourcePath });
      const markdown = buildDerivedMarkdown(relativePath, result.value || '');
      await ensureParentDir(derivedPath);
      await fs.writeFile(derivedPath, markdown, 'utf8');

      extractedCount += 1;
      updatedCount += 1;

      for (const message of result.messages || []) {
        warnings.push(`[${relativePath}] ${message.message}`);
      }
    } catch (error) {
      errorCount += 1;
      warnings.push(`[${relativePath}] ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const derivedFiles = await listFilesRecursive(derivedDocxRoot, (relativePath) => relativePath.endsWith('.md')).catch(() => []);
  for (const relativeDerivedPath of derivedFiles) {
    const absoluteDerivedPath = path.join(derivedDocxRoot, relativeDerivedPath);
    const originalRelativePath = relativeDerivedPath.slice(0, -3);
    const originalAbsolutePath = path.join(workspaceRoot, originalRelativePath);
    const originalExists = await fs.stat(originalAbsolutePath).then(() => true).catch(() => false);

    if (!originalExists && !seenDerived.has(path.normalize(absoluteDerivedPath))) {
      await fs.rm(absoluteDerivedPath, { force: true }).catch(() => undefined);
    }
  }

  await removeEmptyDirs(derivedDocxRoot).catch(() => undefined);

  const status = {
    success: errorCount === 0,
    derivedDocxEnabled: true,
    lastRunAt: new Date().toISOString(),
    workspaceRoot,
    derivedDocxRoot,
    extractedCount,
    updatedCount,
    errorCount,
    warningCount: warnings.length,
    warnings: warnings.slice(0, 50),
  };

  await fs.mkdir(derivedRoot, { recursive: true });
  await fs.writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8');

  console.log(
    `[qmd-derived] DOCX preprocessing complete: extracted=${extractedCount} updated=${updatedCount} errors=${errorCount} warnings=${warnings.length}`,
  );
}

main().catch((error) => {
  console.error(`[qmd-derived] Failed to prepare derived DOCX content: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
