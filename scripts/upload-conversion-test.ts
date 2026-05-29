import assert from 'node:assert/strict';
import sharp from 'sharp';

async function main(): Promise<void> {
  const {
    normalizeUploadImageBuffer,
    parseUploadConvertParams,
  } = await import('../app/lib/images/upload-conversion');
  const {
    getDefaultImageConvertFormat,
    getDefaultImageMaxDimension,
    shouldPreprocessImageFile,
  } = await import('../app/lib/images/client-preprocess');

  assert.deepEqual(parseUploadConvertParams(null, 1), { ok: true, params: null });
  assert.deepEqual(parseUploadConvertParams('[null]', 1), { ok: true, params: [null] });
  assert.equal(parseUploadConvertParams('{"format":"jpg"}', 1).ok, false);
  assert.equal(parseUploadConvertParams('[{"format":"gif","quality":80}]', 1).ok, false);
  assert.equal(parseUploadConvertParams('[{"format":"jpg","quality":101}]', 1).ok, false);
  assert.equal(parseUploadConvertParams('[{"format":"jpg","quality":80,"maxDimension":64}]', 1).ok, false);

  const pngFile = new File([Buffer.alloc(2_000_000)], 'large-transparent.png', { type: 'image/png' });
  const pngPreprocess = shouldPreprocessImageFile(pngFile);
  assert.deepEqual(pngPreprocess, { isHeic: false, isLarge: true });
  assert.equal(getDefaultImageConvertFormat(pngFile, false), 'png');
  assert.equal(getDefaultImageMaxDimension(true), 4096);

  const heicFile = new File([Buffer.from('not-real-heic')], 'camera.HEIC', { type: '' });
  const heicPreprocess = shouldPreprocessImageFile(heicFile);
  assert.deepEqual(heicPreprocess, { isHeic: true, isLarge: false });
  assert.equal(getDefaultImageConvertFormat(heicFile, true), 'jpg');

  const input = await sharp({
    create: {
      width: 320,
      height: 240,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 0.5 },
    },
  }).png().toBuffer();

  const converted = await normalizeUploadImageBuffer({
    buffer: input,
    filename: 'sample.png',
    mimeType: 'image/png',
    convertParams: { format: 'webp', quality: 80, maxDimension: 128 },
  });

  assert.equal(converted.filename, 'sample.webp');
  assert.equal(converted.mimeType, 'image/webp');
  assert.equal(converted.converted, true);
  const metadata = await sharp(converted.buffer).metadata();
  assert.equal(metadata.width, 128);
  assert.equal(metadata.height, 96);

  console.log('upload-conversion-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
