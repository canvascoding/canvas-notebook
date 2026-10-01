import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  compactImageBufferForLlm,
  normalizePiMessagesForLlm,
  resolveApiUploadFileId,
} from '../app/lib/pi/message-normalization';
import { MAX_LLM_IMAGE_BYTES, MAX_LLM_TOTAL_IMAGE_BYTES } from '../app/lib/pi/llm-payload-limits';
import { extractMessageAttachments } from '../app/lib/chat/message-content';
import { parseClientMessage } from '../app/lib/websocket/protocol';

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-attachments-'));
  const pngBytes = Buffer.from('tiny-png-payload');
  const pngBase64 = pngBytes.toString('base64');
  const filePath = path.join(tempDir, 'sample.png');

  try {
    await writeFile(filePath, pngBytes);

    const [fileMessage, dataUrlMessage, base64Message] = await normalizePiMessagesForLlm([
      {
        role: 'user',
        content: [{ type: 'image', data: filePath, mimeType: 'image/png' }],
        timestamp: Date.now(),
      },
      {
        role: 'user',
        content: [{ type: 'image', data: `data:image/png;base64,${pngBase64}`, mimeType: 'image/png' }],
        timestamp: Date.now(),
      },
      {
        role: 'toolResult',
        toolCallId: 'tool-1',
        toolName: 'screenshot',
        content: [{ type: 'image', data: pngBase64, mimeType: 'image/png' }],
        isError: false,
        timestamp: Date.now(),
      },
    ], { allowedImageFileRoots: [tempDir] });

    assert.deepEqual(fileMessage.content, [{ type: 'image', data: pngBase64, mimeType: 'image/png' }]);
    assert.deepEqual(dataUrlMessage.content, [{ type: 'image', data: pngBase64, mimeType: 'image/png' }]);
    assert.deepEqual(base64Message.content, [{ type: 'image', data: pngBase64, mimeType: 'image/png' }]);
    assert.equal(resolveApiUploadFileId('/api/files/screenshot-1.png'), 'screenshot-1.png');
    assert.equal(resolveApiUploadFileId('/api/files/screenshot%20one.png/preview?w=640'), 'screenshot one.png');
    assert.equal(resolveApiUploadFileId('/api/files/preview?path=user-uploads/image/screenshot.png&w=640'), null);
    assert.equal(resolveApiUploadFileId('/api/files/screenshot.png/other'), null);

    const noisyPng = await sharp(randomBytes(900 * 900 * 3), {
      raw: { width: 900, height: 900, channels: 3 },
    }).png().toBuffer();
    assert.ok(noisyPng.length > MAX_LLM_IMAGE_BYTES);
    const compactedImage = await compactImageBufferForLlm(noisyPng, 'noisy.png', 'image/png');
    assert.equal(compactedImage.mimeType, 'image/webp');
    assert.ok(Buffer.byteLength(compactedImage.data, 'base64') <= MAX_LLM_IMAGE_BYTES);

    // Eight ordinary per-image payloads exceeded the aggregate budget and lost
    // some newly attached photos. Exercise WebSocket parsing and real compaction.
    assert.ok(Buffer.byteLength(compactedImage.data, 'base64') * 8 > MAX_LLM_TOTAL_IMAGE_BYTES);
    const photoPaths = Array.from({ length: 8 }, (_, index) => path.join(tempDir, `photo-${index + 1}.png`));
    await Promise.all(photoPaths.map(photoPath => writeFile(photoPath, noisyPng)));
    const metadata = photoPaths.map((photoPath, index) => (
      `--- Attachment: ${path.basename(photoPath)} ---\nfileId: upload-${index + 1}\ncontentKind: image\nmimeType: image/png\n--- Ende Attachment: ${path.basename(photoPath)} ---`
    )).join('\n');
    assert.equal(extractMessageAttachments([{ type: 'text', text: metadata }])?.length, 8);
    const inbound = parseClientMessage(JSON.parse(JSON.stringify({
      type: 'send_message', sessionId: 'eight-photos', message: {
        role: 'user', timestamp: Date.now(), content: [
          { type: 'text', text: 'Compare these eight photos.' },
          ...photoPaths.map(photoPath => ({ type: 'image', data: photoPath, mimeType: 'image/png' })),
        ],
      },
    })));
    assert.ok(inbound.ok && inbound.message.type === 'send_message');
    const [eightPhotoMessage] = await normalizePiMessagesForLlm([inbound.message.message], { allowedImageFileRoots: [tempDir] });
    assert.ok(Array.isArray(eightPhotoMessage.content));
    const photos = eightPhotoMessage.content.filter(part => part.type === 'image');
    assert.equal(photos.length, 8, 'All eight newly attached photos reach the provider payload');
    assert.ok(photos.reduce((total, part) => total + Buffer.byteLength(part.data, 'base64'), 0) <= MAX_LLM_TOTAL_IMAGE_BYTES);
    assert.equal(eightPhotoMessage.content.some(part => part.type === 'text' && /omitted/i.test(part.text)), false);
    for (const photoPath of photoPaths) assert.deepEqual(await readFile(photoPath), noisyPng, 'Provider compaction preserves originals');

    const historyImage = Buffer.alloc(MAX_LLM_IMAGE_BYTES, 1).toString('base64');
    const imageHeavyHistory = await normalizePiMessagesForLlm(
      Array.from({ length: 6 }, (_, index) => ({
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: `Image history turn ${index}` },
          { type: 'image' as const, data: historyImage, mimeType: 'image/png' },
        ],
        timestamp: Date.now() + index,
      })),
    );
    const retainedImageBytes = imageHeavyHistory.reduce((total, message) => (
      Array.isArray(message.content)
        ? total + message.content.reduce((partTotal, part) => (
          part.type === 'image' ? partTotal + Buffer.byteLength(part.data, 'base64') : partTotal
        ), 0)
        : total
    ), 0);
    assert.ok(retainedImageBytes <= MAX_LLM_TOTAL_IMAGE_BYTES);
    assert.match(
      (imageHeavyHistory[0].content as Array<{ type: string; text?: string }>).map((part) => part.text || '').join('\n'),
      /omitted to keep the LLM request/i,
    );

    await assert.rejects(
      normalizePiMessagesForLlm([
        {
          role: 'user',
          content: [{ type: 'image', data: 'not-base64-or-a-file', mimeType: 'image/png' }],
          timestamp: Date.now(),
        },
      ]),
      /Invalid image attachment payload/,
    );

    await assert.rejects(
      normalizePiMessagesForLlm([
        {
          role: 'user',
          content: [{ type: 'image', data: filePath, mimeType: 'image/png' }],
          timestamp: Date.now(),
        },
      ]),
      /outside the trusted workspace or runtime directories/,
    );

    await assert.rejects(
      normalizePiMessagesForLlm([
        {
          role: 'user',
          content: [{ type: 'image', data: `file://${filePath}`, mimeType: 'image/png' }],
          timestamp: Date.now(),
        },
      ]),
      /outside the trusted workspace or runtime directories/,
    );

    const textReferenceResult = await normalizePiMessagesForLlm([
      {
        role: 'user',
        content: [{ type: 'text', text: 'See /etc/passwd.png' }],
        timestamp: Date.now(),
      },
    ], { workspaceImageRoot: tempDir });
    assert.deepEqual(textReferenceResult[0].content, [{ type: 'text', text: 'See /etc/passwd.png' }]);

    console.log('[PI Attachment Test] Passed.');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

void main();
