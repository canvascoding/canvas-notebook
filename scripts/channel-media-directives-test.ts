import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  PASS: ${msg}`);
    passed++;
  }
}

function assertEqual(actual: unknown, expected: unknown, msg: string) {
  if (actual === expected) {
    console.log(`  PASS: ${msg}`);
    passed++;
  } else {
    console.error(`  FAIL: ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  }
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-media-directives-'));
  let outsidePath: string | null = null;
  process.env.CANVAS_DATA_ROOT = tempRoot;
  process.env.DATA = tempRoot;

  const {
    isSafeMediaAttachment,
    parseMediaDirectives,
    validateMediaDirectivePath,
  } = await import('../app/lib/channels/media-directives');

  try {
    const workspaceRoot = path.join(tempRoot, 'workspace');
    const studioRoot = path.join(tempRoot, 'studio', 'outputs');
    const secretsRoot = path.join(tempRoot, 'secrets');
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.mkdir(studioRoot, { recursive: true });
    await fs.mkdir(secretsRoot, { recursive: true });

    const imagePath = path.join(studioRoot, 'result.png');
    const reportPath = path.join(workspaceRoot, 'report.pdf');
    const secretPath = path.join(secretsRoot, 'Canvas-Integrations.env');
    outsidePath = path.join(tempRoot, '..', `outside-${Date.now()}.txt`);
    await fs.writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await fs.writeFile(reportPath, 'pdf-ish');
    await fs.writeFile(secretPath, 'TOKEN=secret');
    await fs.writeFile(outsidePath, 'outside');

    console.log('parseMediaDirectives:');
    const parsed = parseMediaDirectives([
      'Hier ist dein Ergebnis.',
      '[[audio_as_voice]]',
      `MEDIA:${imagePath}`,
      `MEDIA:"${reportPath}"`,
      '',
      '```',
      'MEDIA:/data/studio/outputs/not-real.png',
      '```',
    ].join('\n'));

    assertEqual(parsed.text, ['Hier ist dein Ergebnis.', '', '```', 'MEDIA:/data/studio/outputs/not-real.png', '```'].join('\n'), 'strips directives but keeps fenced code');
    assertEqual(parsed.media.length, 2, 'extracts two media directives');
    assertEqual(parsed.media[0].rawPath, imagePath, 'extracts unquoted path');
    assertEqual(parsed.media[1].rawPath, reportPath, 'extracts quoted path');
    assert(parsed.audioAsVoice, 'detects audio_as_voice tag');
    assert(!parsed.asDocument, 'does not set as_document when absent');

    const documentParsed = parseMediaDirectives(`[[as_document]]\nMEDIA:${imagePath}`);
    assert(documentParsed.asDocument, 'detects as_document tag');
    assertEqual(documentParsed.text, '', 'allows media-only responses');

    console.log('\nvalidateMediaDirectivePath:');
    const safeImage = await validateMediaDirectivePath(imagePath);
    assert(isSafeMediaAttachment(safeImage), 'allows Studio output files');

    const safeReport = await validateMediaDirectivePath(`"${reportPath}"`);
    assert(isSafeMediaAttachment(safeReport), 'allows workspace files with wrapping quotes');

    const secret = await validateMediaDirectivePath(secretPath);
    assert(!isSafeMediaAttachment(secret) && secret.reason === 'denied_path', 'blocks secrets directory');

    const relative = await validateMediaDirectivePath('studio/outputs/result.png');
    assert(!isSafeMediaAttachment(relative) && relative.reason === 'path_must_be_absolute', 'blocks relative paths');

    const outside = await validateMediaDirectivePath(outsidePath);
    assert(!isSafeMediaAttachment(outside) && outside.reason === 'outside_allowed_roots', 'blocks files outside allowed roots');

    const tooLarge = await validateMediaDirectivePath(imagePath, { maxBytes: 2 });
    assert(!isSafeMediaAttachment(tooLarge) && tooLarge.reason === 'file_too_large', 'enforces maxBytes');
  } finally {
    if (outsidePath) {
      await fs.rm(outsidePath, { force: true });
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main()
  .catch((error) => {
    console.error(error);
    failed++;
  })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  });
